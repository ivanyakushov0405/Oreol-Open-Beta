import { useEffect, useRef, useState } from 'react';
import { paths } from '../../app/router';
import type { AppState } from '../../app/useAppState';
import { playSound } from '../../shared/audio/sounds';
import { Icon } from '../../shared/icons';
import { displayNameOf } from '../../shared/api';
import { firstPhotoUrl, handleOf, previewText } from '../../shared/model';
import { Avatar } from '../../shared/ui/Avatar';
import { mentionsMe } from '../chat/mentions';
import { chatUnread } from '../chat/unread';
import { DisplayName } from '../members/Nick';
import { isMuted } from './mute';
import { NEW_MESSAGE, type NewMessage } from '../chat/useChat';
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

/**
 * The title always carries the real number of unread messages; while the tab is hidden it alternates with the latest
 * message.
 */
const tabTitle = { count: 0, line: '', timer: 0 };
function paintTitle() {
  const counted = tabTitle.count > 0 ? `(${tabTitle.count > 99 ? '99+' : tabTitle.count}) ${BRAND}` : BRAND;
  if (!tabTitle.line || document.visibilityState === 'visible') {
    window.clearInterval(tabTitle.timer);
    tabTitle.timer = 0;
    tabTitle.line = '';
    document.title = counted;
    return;
  }
  if (tabTitle.timer) return;
  document.title = counted;
  let showLine = false;
  tabTitle.timer = window.setInterval(() => {
    showLine = !showLine;
    const n = tabTitle.count > 0 ? `(${tabTitle.count > 99 ? '99+' : tabTitle.count}) ${BRAND}` : BRAND;
    document.title = showLine && tabTitle.line ? tabTitle.line : n;
  }, 1500);
}
function titleAlert(line: string) {
  if (document.visibilityState === 'visible') return;
  tabTitle.line = line;
  paintTitle();
}
document.addEventListener('visibilitychange', paintTitle);

/** Keeps the title count equal to the unread total of all my servers. */
export function useTitleCount(n: number) {
  useEffect(() => {
    tabTitle.count = n;
    paintTitle();
  }, [n]);
}

type Alert = { key: string; user: string; text: string; where: string; path: string; mention: boolean; photo?: string | null };
const SHOW_MS = 6000;
const MAX = 3;

export function MessageAlerts({ app }: { app: AppState }) {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  // The open server is counted live from its loaded chats, the others come from the server.
  const here = chatUnread(app, app.general) + chatUnread(app, app.lobby);
  useTitleCount(app.servers.reduce((n, s) => n + (s.id === app.serverId ? here : app.serverUnread[s.id]?.count ?? 0), 0));
  const seen = useRef(new Set<string>());
  const appRef = useRef(app);
  appRef.current = app;

  useEffect(() => {
    const onNew = (e: Event) => {
      const { room, message: m } = (e as CustomEvent<NewMessage>).detail;
      const app = appRef.current;
      const id = String(m.id);
      // Each message comes over both sockets of the open server.
      if (seen.current.has(id)) return;
      seen.current.add(id);
      if (seen.current.size > 500) seen.current = new Set([...seen.current].slice(-200));
      if ((m.sys && m.sys !== 'pin') || m.user === app.name || isWatching(room)) return;
      const server = app.servers.find((x) => x.channels.some((c) => c.room === room));
      const channel = server?.channels.find((c) => c.room === room);
      if (!server || !channel) return;
      const mention = mentionsMe(m.content || '', handleOf(app.name));
      if (!mention && isMuted(room)) return;
      playSound(mention ? 'mention' : 'message');
      const where = (channel.kind === 'voice' ? t('Чат «{0}»', { 0: channel.name }) : `#${channel.name}`) + ' · ' + server.name;
      const pinned = m.reply && 'content' in m.reply ? (m.reply.content || '').trim() : '';
      const text = m.sys === 'pin' ? t('Закрепил(а): {0}', { 0: pinned || t('сообщение') }) : previewText(m).trim() || t('Вложение');
      const photo = m.sys === 'pin' ? (m.reply && 'photo' in m.reply ? m.reply.photo : null) : firstPhotoUrl(m.attachments);
      titleAlert(`${displayNameOf(m.user)}: ${text}`);
      setAlerts((a) =>
        [...a.filter((x) => x.key !== room), { key: room, user: m.user, text, where, path: paths.channel(server.id, channel.id, channel.kind === 'voice'), mention, photo }].slice(-MAX),
      );
    };
    window.addEventListener(NEW_MESSAGE, onNew);
    return () => window.removeEventListener(NEW_MESSAGE, onNew);
  }, []);

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
