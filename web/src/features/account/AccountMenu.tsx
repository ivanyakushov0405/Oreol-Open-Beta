import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AppState } from '../../app/useAppState';
import { Icon } from '../../shared/icons';
import { handleOf, type Status } from '../../shared/model';
import { Avatar, Banner } from '../../shared/ui/Avatar';
import { t } from '../../shared/i18n';

export const STATUS_ITEMS: { id: Status; label: string }[] = [
  { id: 'online', label: t('В сети') },
  { id: 'idle', label: t('Не активен') },
  { id: 'dnd', label: t('Не беспокоить') },
  { id: 'offline', label: t('Невидимый') },
];

export function AccountMenu({
  app,
  onClose,
  onSettings,
  onProfile,
}: {
  app: AppState;
  onClose: () => void;
  onSettings: () => void;
  onProfile: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || (t as Element).closest?.('.user-panel .who')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown);
    };
  }, [onClose]);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const panel = document.querySelector('.user-panel');
      if (!panel) return;
      const r = panel.getBoundingClientRect();
      setPos({ left: Math.max(8, r.left - 4), bottom: window.innerHeight - r.top + 8 });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, []);
  if (!pos) return null;
  return createPortal(
    <div className="acct-menu" role="menu" ref={ref} style={{ left: pos.left, bottom: pos.bottom }}>
      <Banner name={app.name} />
      <div className="acct-body">
        <span className="mc-avatar">
          <Avatar name={app.name} size={72} status={app.status} />
        </span>
        <div className="acct-id">
          <h3>{app.me.displayName}</h3>
          <span>{handleOf(app.name)}</span>
        </div>
        <div className="acct-items">
          <div className="acct-over">{t('Статус')}</div>
          {STATUS_ITEMS.map((s) => (
            <button
              key={s.id}
              role="menuitemradio"
              aria-checked={app.status === s.id}
              className={'acct-item' + (app.status === s.id ? ' on' : '')}
              onClick={() => app.setStatus(s.id)}
            >
              <i className={`acct-dot status-${s.id}`} />
              {s.label}
            </button>
          ))}
          <hr />
          <button role="menuitem" className="acct-item" onClick={onProfile}>
            <Icon name="pencil" size={18} />
            {t('Редактировать профиль')}
          </button>
          <button role="menuitem" className="acct-item" onClick={onSettings}>
            <Icon name="settings" size={18} />
            {t('Настройки')}
          </button>
          <hr />
          <button role="menuitem" className="acct-item danger" onClick={app.logout}>
            <Icon name="logout" size={18} />
            {t('Выйти')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
