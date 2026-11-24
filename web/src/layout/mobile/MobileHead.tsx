import { springPress } from '../../shared/ui/press';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon, type IconName } from '../../shared/icons';
import { t } from '../../shared/i18n';

export function Head({
  title,
  sub,
  onBack,
  avatar,
  icon,
  actions,
  actionsHidden,
  swapKey,
  fromTitle,
  onTitle,
}: {
  title: string;
  sub?: React.ReactNode;
  onBack: () => void;
  avatar?: React.ReactNode;
  icon?: IconName;
  actions?: React.ReactNode;
  actionsHidden?: boolean;
  swapKey?: string;
  fromTitle?: string;
  /** Makes the title pill a button (chat info). */
  onTitle?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const last = useRef({ key: swapKey, title, icon });
  const [ghost, setGhost] = useState<{ title: string; icon?: IconName } | null>(fromTitle ? { title: fromTitle } : null);
  const [bump, setBump] = useState(1);
  const [pop, setPop] = useState(!fromTitle);
  useEffect(() => {
    if (!pop) return;
    const id = window.setTimeout(() => setPop(false), 480);
    return () => window.clearTimeout(id);
  }, [pop]);
  useLayoutEffect(() => {
    if (last.current.key !== swapKey) {
      setGhost({ title: last.current.title, icon: last.current.icon });
      setBump((b) => b + 1);
    }
    last.current = { key: swapKey, title, icon };
  });
  useEffect(() => {
    if (!ghost) return;
    const id = window.setTimeout(() => setGhost(null), 320);
    return () => window.clearTimeout(id);
  }, [ghost]);
  // Restart the animation without recreating elements by alternating two identical classes.
  const bumpCls = pop || (bump === 1 && !fromTitle) ? '' : bump % 2 ? ' bump-a' : ' bump-b';
  const swapIn = bump > 1 || ghost ? ' sw-in' : '';
  return (
    <div className={'m-head' + (pop ? ' pop' : '')} ref={ref}>
      <button className={'pill-btn glass' + bumpCls} onClick={(e) => (springPress(e.currentTarget), onBack())} title={t('Назад')}>
        <Icon name="back" />
      </button>
      <div
        className={'title-pill glass' + bumpCls + (onTitle ? ' tappable' : '')}
        {...(onTitle && { role: 'button', tabIndex: 0, onClick: onTitle, onKeyDown: (e: React.KeyboardEvent) => e.key === 'Enter' && onTitle() })}
      >
        {avatar}
        {(icon || ghost?.icon) && (
          <span className="ico-swap">
            {icon && <Icon key={'i-' + (swapKey ?? '') + icon} name={icon} size={24} className={'title-ico' + swapIn} />}
            {ghost?.icon && <Icon name={ghost.icon} size={24} className="title-ico sw-out" />}
          </span>
        )}
        <div style={{ minWidth: 0 }}>
          <div className="t-wrap">
            <div key={'t-' + (swapKey ?? '') + title} className={'t' + swapIn}>
              {title}
            </div>
            {ghost && (
              <div className="t sw-out" aria-hidden="true">
                {ghost.title}
              </div>
            )}
          </div>
          {sub != null && <div className="s">{sub}</div>}
        </div>
      </div>
      {actions && (
        <div className={'group glass' + (actionsHidden ? ' gone' : bumpCls)} aria-hidden={actionsHidden || undefined}>
          {actions}
        </div>
      )}
    </div>
  );
}

