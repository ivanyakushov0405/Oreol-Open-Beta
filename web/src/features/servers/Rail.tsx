import { useState, type PointerEvent as RPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import type { AppState } from '../../app/useAppState';
import { Icon, LogoPeople } from '../../shared/icons';
import type { ServerId } from '../../shared/model';
import { useVoiceCounts } from '../voice/useVoice';
import { t } from '../../shared/i18n';

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
