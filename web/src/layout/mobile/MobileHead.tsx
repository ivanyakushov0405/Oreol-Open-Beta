import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon, type IconName } from '../../shared/icons';

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
}: {
  title: string;
  sub?: React.ReactNode;
  onBack: () => void;
  avatar?: React.ReactNode;
  /** Иконка канала слева в заголовке (Figma: «Chat header» → Title → Icon). */
  icon?: IconName;
  /** Кнопки справа (Figma: группа «Actions» в шапке). */
  actions?: React.ReactNode;
  /** Кнопки справа плавно спрятаны (например, кнопка чата, когда чат уже открыт). */
  actionsHidden?: boolean;
  /** Смена «экрана» внутри шапки (войс ↔ чат Лобби): кнопки подпрыгивают, название растворяется и проявляется новое. */
  swapKey?: string;
  /** Название экрана, с которого пришли (настройки → раздел): при открытии оно растворяется в новое. */
  fromTitle?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const last = useRef({ key: swapKey, title, icon });
  // Уходящее название и иконка (подпись — время, пинг — не трогаем: она общая и живая)
  const [ghost, setGhost] = useState<{ title: string; icon?: IconName } | null>(fromTitle ? { title: fromTitle } : null);
  /** Счётчик «подпрыгиваний»: при открытии экрана и при каждой смене swapKey. */
  const [bump, setBump] = useState(1);
  /** Экран открыт из списка (до него шапки не было): кнопки «вырастают из ничего». */
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
  // Перезапуск анимации без пересоздания элементов: чередуем два одинаковых класса
  const bumpCls = pop || (bump === 1 && !fromTitle) ? '' : bump % 2 ? ' bump-a' : ' bump-b';
  const swapIn = bump > 1 || ghost ? ' sw-in' : '';
  return (
    <div className={'m-head' + (pop ? ' pop' : '')} ref={ref}>
      <button className={'pill-btn glass' + bumpCls} onClick={onBack} title="Назад">
        <Icon name="back" />
      </button>
      <div className={'title-pill glass' + bumpCls}>
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

/** Высота полосы под свёрнутой пилюлей (без отступа под строку состояния). */
