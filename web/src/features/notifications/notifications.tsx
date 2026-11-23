import { useEffect, useRef, useState } from 'react';
import { paths } from '../../app/router';
import type { AppState } from '../../app/useAppState';
import { playSound } from '../../shared/audio/sounds';
import { Icon } from '../../shared/icons';
import { displayNameOf } from '../../shared/api';
import { firstPhotoUrl, handleOf, previewText } from '../../shared/model';
import { Avatar } from '../../shared/ui/Avatar';
import { mentionsMe } from '../chat/mentions';
import { DisplayName } from '../members/Nick';
import { isMuted } from './mute';
import { BRAND, t } from '../../shared/i18n';

const openChats = new Map<string, number>();
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

/** While the tab is hidden the title counts new messages and alternates with the latest one. */
const tabTitle = { count: 0, line: '', timer: 0 };
function titleAlert(line: string) {
  if (document.visibilityState === 'visible') return;
  tabTitle.count++;
  tabTitle.line = line;
  const counted = () => `(${tabTitle.count}) ${BRAND}`;
  document.title = counted();
  if (tabTitle.timer) return;
  let showLine = false;
  tabTitle.timer = window.setInterval(() => {
    showLine = !showLine;
    document.title = showLine ? tabTitle.line : counted();
  }, 1500);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  window.clearInterval(tabTitle.timer);
  Object.assign(tabTitle, { count: 0, line: '', timer: 0 });
  document.title = BRAND;
});

type Alert = { key: string; user: string; text: string; where: string; path: string; mention: boolean; photo?: string | null };
const SHOW_MS = 6000;
const MAX = 3;

export function MessageAlerts({ app }: { app: AppState }) {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const last = useRef(new Map<string, number>());
  const myTag = handleOf(app.name);

  const watch = (chat: AppState['general'], channel: AppState['textChannel']) => {
    if (!channel) return;
    const room = channel.room;
    const msgs = chat.messages;
    // Until history arrives the chat is empty, which is not "all read"; otherwise all loaded history counted as new.
    if (!msgs.length) return;
    const top = Number(msgs[msgs.length - 1].id) || 0;
    const prev = last.current.get(room);
    last.current.set(room, Math.max(prev ?? 0, top));
    if (prev === undefined || top <= prev) return;
    // Only what just arrived, not history loaded again when returning to the server.
    const now = Date.now();
    const fresh = msgs.filter(
      (m) => Number(m.id) > prev && (!m.sys || m.sys === 'pin') && m.user !== app.name && (!m.ts || now - new Date(m.ts).getTime() < 30_000),
    );
    if (!fresh.length || isWatching(room)) return;
    const mention = fresh.some((m) => mentionsMe(m.content || '', myTag));
    if (!mention && isMuted(room)) return;
    playSound(mention ? 'mention' : 'message');
    const m = fresh[fresh.length - 1];
    const where = (channel.kind === 'voice' ? t('Чат «{0}»', { 0: channel.name }) : `#${channel.name}`) + ' · ' + app.server.name;
    const pinned = m.reply && 'content' in m.reply ? (m.reply.content || '').trim() : '';
    const text = m.sys === 'pin' ? t('Закрепил(а): {0}', { 0: pinned || t('сообщение') }) : previewText(m).trim() || t('Вложение');
    const photo = m.sys === 'pin' ? (m.reply && 'photo' in m.reply ? m.reply.photo : null) : firstPhotoUrl(m.attachments);
    titleAlert(`${displayNameOf(m.user)}: ${text}`);
    setAlerts((a) =>
      [...a.filter((x) => x.key !== room), { key: room, user: m.user, text, where, path: paths.channel(app.serverId, channel.id, channel.kind === 'voice'), mention, photo }].slice(-MAX),
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
      {al.photo && <img className="msg-alert-thumb" src={al.photo} alt="" draggable={false} />}
      <button
        className="msg-alert-x"
        aria-label={t('Закрыть')}
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
