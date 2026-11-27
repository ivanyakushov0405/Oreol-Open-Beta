import { useEffect, useState, type PointerEvent as RPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import type { AppState } from '../../app/useAppState';
import { Icon, LogoPeople } from '../../shared/icons';
import type { ServerId } from '../../shared/model';
import { useVoiceCounts } from '../voice/useVoice';
import { t } from '../../shared/i18n';
import { chatUnread, UnreadBadge } from '../chat/unread';

export function Rail({
  app,
  home,
  onHome,
  onServer,
  noHome,
}: {
  app: AppState;
  home: boolean;
  onHome: () => void;
  onServer: (id: ServerId) => void;
  noHome?: boolean;
}) {
  const inVoice = app.voice.state === 'connected';
  const counts = useVoiceCounts(app.servers.map((s) => s.id));
  const unread = app.serverUnread;
  // The open server counts live from its chats once they hold its rooms; until then (just switched) the server's own
  // count stays, so the badge does not drop out and come back.
  const srv = app.servers.find((s) => s.id === app.serverId);
  const own = (room: string | null) => !!room && !!srv?.channels.some((c) => c.room === room);
  const live = useCalmRise(chatUnread(app, app.general) + (own(app.lobby.room) ? chatUnread(app, app.lobby) : 0));
  const here = own(app.general.room) ? live : unread[app.serverId]?.count ?? 0;
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);
  const hover = (text: string) => ({
    // Tooltip only for mouse: on phones every tap "hovers" and it just got in the way.
    onPointerEnter: (e: RPointerEvent<HTMLElement>) => {
      if (e.pointerType !== 'mouse') return;
      const r = e.currentTarget.getBoundingClientRect();
      setTip({ text, x: r.right + 14, y: r.top + r.height / 2 });
    },
    onPointerLeave: () => setTip(null),
  });
  return (
    <nav className="rail glass" onScroll={() => setTip(null)}>
      {!noHome && (
        <>
          <button className={'rail-home' + (home ? ' on' : '')} aria-label={t('Личные сообщения')} onClick={onHome} {...hover(t('Личные сообщения'))}>
            <LogoPeople size={30} />
          </button>
          <div className="rail-sep" />
        </>
      )}
      {app.servers.map((s) => {
        const n = inVoice && app.voice.server === s.id ? app.voice.peers.length : counts[s.id] ?? 0;
        return (
        <button
          key={s.id}
          className={'server-icon' + (s.id === app.serverId && !home ? ' on' : '')}
          style={{ background: s.gradient }}
          aria-label={s.name}
          {...hover(s.name)}
          onClick={() => onServer(s.id)}
        >
          {s.short}
          <UnreadBadge n={s.id === app.serverId ? here : unread[s.id]?.count ?? 0} className="server-unread" rooms={s.channels.map((c) => c.room)} />
          {n > 0 && (
            <span className={'voice-badge' + (inVoice && app.voice.server === s.id ? ' mine' : '')}>
              <Icon name="mic" size={12} />
              {n}
            </span>
          )}
        </button>
        );
      })}
      <button
        className="rail-add"
        aria-label={t('Создать сервер')}
        {...hover(t('Создать сервер'))}
        onClick={() => app.notify(t('Создание серверов скоро будет'))}
      >
        <Icon name="plus" />
      </button>
      {tip &&
        createPortal(
          <div className="rail-tip" style={{ left: tip.x, top: tip.y }} key={tip.text}>
            {tip.text}
          </div>,
          document.body,
        )}
    </nav>
  );
}

/**
 * A rise shows a moment later. A message that lands in the open chat counts as unread until the read mark returns,
 * and showing that at once made the badge blink in and out.
 */
function useCalmRise(n: number, ms = 1200) {
  const [shown, setShown] = useState(n);
  useEffect(() => {
    if (n <= shown) return void setShown(n);
    const id = window.setTimeout(() => setShown(n), ms);
    return () => window.clearTimeout(id);
  }, [n]); // eslint-disable-line react-hooks/exhaustive-deps
  return Math.min(n, shown);
}
