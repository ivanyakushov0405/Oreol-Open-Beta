import { Fragment, useRef, type ReactNode } from 'react';
import { Icon, type IconName } from '../../shared/icons';

export function pressIcon(el: HTMLElement) {
  el.removeAttribute('data-press');
  void el.offsetWidth;
  el.setAttribute('data-press', '');
  const token = String(Date.now() + Math.random());
  el.dataset.pressId = token;
  // самая длинная анимация иконки — 1 с (микрофон), потом снимаем атрибут
  window.setTimeout(() => {
    if (el.dataset.pressId !== token) return;
    el.removeAttribute('data-press');
  }, 1100);
}

/** Разделы, между которыми переход — это «просмотр ↔ редактирование», а не смена вкладки. */
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
  /** Окно уходит — играет анимация закрытия. */
  closing?: boolean;
  nav: { id: T; label: string; icon: IconName; group?: string }[];
  section: T;
  /** Подсвеченный пункт навигации, если раздел — подстраница. */
  active?: T;
  onSection: (s: T) => void;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  // Переключение «просмотр ↔ редактирование» учётной записи — своя анимация (проявление из размытия);
  // переход между вкладками — обычная. Помним, откуда пришли, пока раздел не сменится снова.
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
                <Icon name={n.icon} size={20} />
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
        {/* Шапка из Figma: заголовок H1 + кнопка закрытия 32×32 r10 с подписью ESC */}
        <div className="settings-head">
          <h1>{title}</h1>
          <div className="settings-close">
            <button type="button" className="settings-x" onClick={onClose} title="Закрыть (Esc)" aria-label="Закрыть">
              <Icon name="close" size={20} />
            </button>
            <span>ESC</span>
          </div>
        </div>
        {/* ключ по разделу — при смене раздела содержимое заново проявляется (анимация set-sec-in) */}
        <Fragment key={section}>{children}</Fragment>
      </main>
    </div>
  );
}
