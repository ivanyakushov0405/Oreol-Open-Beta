import { useState, type MouseEvent as RMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import type { AppState } from '../../app/useAppState';
import { Icon, LogoPeople } from '../../shared/icons';
import type { ServerId } from '../../shared/model';
import { useVoiceCounts } from '../voice/useVoice';

/* ---------- Рейл серверов ---------- */
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
  // Метка «в войсе N» над каждым сервером, где кто-то сидит (а не только где сидим мы)
  const counts = useVoiceCounts(app.servers.map((s) => s.id));
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);
  const hover = (text: string) => ({
    onMouseEnter: (e: RMouseEvent<HTMLElement>) => {
      const r = e.currentTarget.getBoundingClientRect();
      setTip({ text, x: r.right + 14, y: r.top + r.height / 2 });
    },
    onMouseLeave: () => setTip(null),
  });
  return (
    <nav className="rail glass" onScroll={() => setTip(null)}>
      {/* На телефоне личные сообщения — вкладка «Чаты» в таб-панели, на рейле их нет */}
      {!noHome && (
        <>
          <button className={'rail-home' + (home ? ' on' : '')} aria-label="Личные сообщения" onClick={onHome} {...hover('Личные сообщения')}>
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
        aria-label="Создать сервер"
        {...hover('Создать сервер')}
        onClick={() => app.notify('Создание серверов — скоро будет')}
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
