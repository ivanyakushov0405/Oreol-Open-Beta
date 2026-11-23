import { Fragment, useRef, type ReactNode } from 'react';
import { ChatsIcon, Icon, SlidersIcon, type IconName } from '../../shared/icons';
import { t } from '../../shared/i18n';

export function pressIcon(el: HTMLElement) {
  el.removeAttribute('data-press');
  void el.offsetWidth;
  el.setAttribute('data-press', '');
  const token = String(Date.now() + Math.random());
  el.dataset.pressId = token;
  // The longest icon animation is 1 s (microphone), then the attribute is removed.
  window.setTimeout(() => {
    if (el.dataset.pressId !== token) return;
    el.removeAttribute('data-press');
  }, 1100);
}

const SWAP_GROUP: string[] = ['account', 'profile', 'account-edit'];

export function SettingsScreen<T extends string>({
  title,
  overline,
  nav,
  section,
  onSection,
  onClose,
  footer,
  children,
  active,
  closing,
}: {
  title: string;
  overline: string;
  closing?: boolean;
  nav: { id: T; label: string; icon: IconName; group?: string }[];
  section: T;
  active?: T;
  onSection: (s: T) => void;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  // Account view/edit switching has its own animation (fade out of blur); tab changes use the normal one.
  // Remember where we came from until the section changes again.
  const last = useRef(section);
  const swap = useRef(false);
  if (last.current !== section) {
    swap.current = SWAP_GROUP.includes(last.current) && SWAP_GROUP.includes(section);
    last.current = section;
  }
  return (
    <div className={'settings' + (closing ? ' closing' : '')}>
      <nav className="settings-nav glass">
        <div className="overline">{overline}</div>
        {nav.map((n, i) => (
          <Fragment key={n.id}>
            {n.group && <div className="overline">{n.group}</div>}
            <button
              className={'nav-item' + ((active ?? section) === n.id ? ' on' : '')}
              data-ico={n.icon}
              style={{ '--i': i } as React.CSSProperties}
              onClick={(e) => {
                pressIcon(e.currentTarget);
                onSection(n.id);
              }}
            >
              <span className="si">
                {n.icon === 'settings' ? <SlidersIcon size={20} /> : n.icon === 'chats' ? <ChatsIcon size={20} /> : <Icon name={n.icon} size={20} />}
                {n.icon === 'mic' && <Icon name="mic" size={20} className="si-fill" />}
                {n.icon === 'appearance' && <Icon name="appearance" size={20} className="si-paint" />}
              </span>
              {n.label}
            </button>
          </Fragment>
        ))}
        {footer}
      </nav>
      <main className={'settings-body glass' + (swap.current ? ' swap' : '')}>
        <div className="settings-head">
          <h1>{title}</h1>
          <div className="settings-close">
            <button type="button" className="settings-x" onClick={onClose} title={t('Закрыть (Esc)')} aria-label={t('Закрыть')}>
              <Icon name="close" size={20} />
            </button>
            <span>ESC</span>
          </div>
        </div>
        <Fragment key={section}>{children}</Fragment>
      </main>
    </div>
  );
}
