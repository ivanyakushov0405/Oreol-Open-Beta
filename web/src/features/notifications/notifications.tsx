import { useEffect, useRef, useState } from 'react';
import { paths } from '../../app/router';
import type { AppState } from '../../app/useAppState';
import { playSound } from '../../shared/audio/sounds';
import { Icon } from '../../shared/icons';
import { handleOf, previewText } from '../../shared/model';
import { Avatar } from '../../shared/ui/Avatar';
import { mentionsMe } from '../chat/mentions';
import { DisplayName } from '../members/Nick';

/* ---------- Какие чаты сейчас открыты на экране (их сообщения не озвучиваем и не показываем) ---------- */
const openChats = new Map<string, number>();
/** Ставится в открытом чате: пока он на экране и вкладка видна, уведомлений о его сообщениях нет. */
export function useOpenChat(room: string | null | undefined) {
  useEffect(() => {
    if (!room) return;
    openChats.set(room, (openChats.get(room) ?? 0) + 1);
    return () => {
      const n = (openChats.get(room) ?? 1) - 1;
      if (n > 0) openChats.set(room, n);
      else openChats.delete(room);
    };
  }, [room]);
}
const isWatching = (room: string) => openChats.has(room) && document.visibilityState === 'visible';

type Alert = { key: string; user: string; text: string; where: string; path: string; mention: boolean };
const SHOW_MS = 6000;
const MAX = 3;

/** Новые сообщения в чатах сервера: звук и карточка справа внизу (если этот чат сейчас не открыт). */
export function MessageAlerts({ app }: { app: AppState }) {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const last = useRef(new Map<string, number>());
  const myTag = handleOf(app.name);

  const watch = (chat: AppState['general'], channel: AppState['textChannel']) => {
    if (!channel) return;
    const room = channel.room;
    const msgs = chat.messages;
    // пока история не пришла, чат пустой — это не «всё прочитано»: иначе вся загруженная история считалась новой
    if (!msgs.length) return;
    const top = Number(msgs[msgs.length - 1].id) || 0;
    const prev = last.current.get(room);
    last.current.set(room, Math.max(prev ?? 0, top));
    // первая загрузка истории — не уведомляем о старом
    if (prev === undefined || top <= prev) return;
    // только то, что пришло только что (а не догрузилось из истории при возвращении на сервер)
    const now = Date.now();
    const fresh = msgs.filter(
      (m) => Number(m.id) > prev && !m.sys && m.user !== app.name && (!m.ts || now - new Date(m.ts).getTime() < 30_000),
    );
    if (!fresh.length || isWatching(room)) return;
    const mention = fresh.some((m) => mentionsMe(m.content || '', myTag));
    playSound(mention ? 'mention' : 'message');
    const m = fresh[fresh.length - 1];
    const where = (channel.kind === 'voice' ? `Чат «${channel.name}»` : `#${channel.name}`) + ' · ' + app.server.name;
    const text = previewText(m).trim() || 'Вложение';
    setAlerts((a) =>
      [...a.filter((x) => x.key !== room), { key: room, user: m.user, text, where, path: paths.channel(app.serverId, channel.id, channel.kind === 'voice'), mention }].slice(-MAX),
    );
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => watch(app.general, app.textChannel), [app.general.messages]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => watch(app.lobby, app.voiceChannel), [app.lobby.messages]);

  const close = (key: string) => setAlerts((a) => a.filter((x) => x.key !== key));
  const open = (al: Alert) => {
    close(al.key);
    history.pushState({ prev: location.pathname }, '', al.path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  };

  return (
    <div className="msg-alerts" aria-live="polite">
      {alerts.map((al) => (
        <AlertCard key={al.key + al.text} al={al} onOpen={() => open(al)} onClose={() => close(al.key)} />
      ))}
    </div>
  );
}

function AlertCard({ al, onOpen, onClose }: { al: Alert; onOpen: () => void; onClose: () => void }) {
  const [out, setOut] = useState(false);
  const hover = useRef(false);
  useEffect(() => {
    let t = 0;
    const arm = () => {
      t = window.setTimeout(() => (hover.current ? arm() : setOut(true)), SHOW_MS);
    };
    arm();
    return () => window.clearTimeout(t);
  }, []);
  return (
    <div
      className={'msg-alert' + (al.mention ? ' mention' : '') + (out ? ' out' : '')}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => e.key === 'Enter' && onOpen()}
      onMouseEnter={() => (hover.current = true)}
      onMouseLeave={() => (hover.current = false)}
      onAnimationEnd={(e) => e.animationName === 'msg-alert-out' && onClose()}
    >
      <Avatar name={al.user} size={36} />
      <div className="msg-alert-body">
        <div className="msg-alert-top">
          <b>
            <DisplayName name={al.user} />
          </b>
          <span>{al.where}</span>
        </div>
        <div className="msg-alert-text">{al.text}</div>
      </div>
      <button
        className="msg-alert-x"
        aria-label="Закрыть"
        onClick={(e) => {
          e.stopPropagation();
          setOut(true);
        }}
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}
