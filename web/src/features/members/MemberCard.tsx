import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useUser } from '../../shared/api';
import { Icon } from '../../shared/icons';
import { handleOf, nameColor, type Status } from '../../shared/model';
import { Avatar, Banner } from '../../shared/ui/Avatar';
import { Modal } from '../../shared/ui/Modal';

const sinceFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

/** Карточка участника (Figma «Member card (open)», 300px): баннер 84, аватар 72, блок сведений и две кнопки. */
export function MemberCard({
  name,
  me,
  at,
  activity,
  since,
  serverName,
  onClose,
  onProfile,
  sheet,
  serverIcon,
  onCall,
  full,
  status = 'online',
}: {
  name: string;
  me: boolean;
  status?: Status;
  /** Мобильная версия: карточка выезжает снизу шторкой (Figma «Mobile · Member sheet»). */
  sheet?: boolean;
  /** Иконка сервера для блока «Общие серверы» в развёрнутой шторке. */
  serverIcon?: { short: string; gradient: string };
  onCall?: () => void;
  /** Телефон: содержимое развёрнутой шторки — полный профиль, как окно профиля на десктопе. */
  full?: ReactNode;
  at: { x: number; y: number };
  activity: string;
  since: Date;
  serverName: string;
  onClose: () => void;
  onProfile: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const profile = useUser(name);
  const display = profile?.displayName || name;
  const [pos, setPos] = useState({ left: at.x, top: at.y });
  // Шторка: тянуть за верх вверх — развернуть, вниз — свернуть/закрыть (Figma «Member sheet · expanded»)
  const [expanded, setExpandedState] = useState(false);
  // Доп. блоки показываем сразу при разворачивании и убираем только после того, как шторка свернулась
  const [extras, setExtras] = useState(false);
  // Высота свёрнутой шторки — меряем один раз, чтобы анимировать высоту между двумя числами
  const [h0, setH0] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (sheet && ref.current) setH0(ref.current.offsetHeight);
  }, [sheet]);
  const expRef = useRef(false);
  /** Карточка появилась при сворачивании из профиля — для обратной анимации. */
  const [back, setBack] = useState(false);
  const setExpanded = (v: boolean | ((x: boolean) => boolean)) => {
    setExpandedState((x) => {
      const next = typeof v === 'function' ? v(x) : v;
      // Разворот — сразу полный профиль; сворот — сразу карточка, она «собирается» обратно, пока шторка опускается
      if (next) {
        setExtras(true);
        setBack(false);
      } else if (x) {
        setExtras(false);
        setBack(true);
      }
      expRef.current = next;
      return next;
    });
  };
  const [drag, setDrag] = useState(0);
  const dragFrom = useRef<number | null>(null);
  const noteKey = `oreol.note.${name}`;
  const [note, setNote] = useState(() => {
    try {
      return localStorage.getItem(noteKey) ?? '';
    } catch {
      return '';
    }
  });
  const saveNote = (v: string) => {
    setNote(v);
    try {
      localStorage.setItem(noteKey, v);
    } catch {
      /* хранилище недоступно */
    }
  };
  const grab = {
    onPointerDown: (e: React.PointerEvent) => {
      dragFrom.current = e.clientY;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (dragFrom.current !== null) setDrag(e.clientY - dragFrom.current);
    },
    onPointerUp: () => {
      const dy = drag;
      dragFrom.current = null;
      setDrag(0);
      if (Math.abs(dy) < 6) setExpanded((x) => !x);
      else if (dy < -40) setExpanded(true);
      else if (dy > 60) {
        if (expanded) setExpanded(false);
        else onClose();
      }
    },
    onPointerCancel: () => {
      dragFrom.current = null;
      setDrag(0);
    },
  };
  useLayoutEffect(() => {
    const h = ref.current?.offsetHeight ?? 409;
    setPos({
      left: Math.max(8, Math.min(at.x, window.innerWidth - 308)),
      top: Math.max(8, Math.min(at.y, window.innerHeight - h - 8)),
    });
  }, [at.x, at.y]);
  return (
    <Modal onClose={onClose}>
      <div
        className="popover-backdrop"
        onClick={onClose}
        onContextMenu={(e) => {
          // ПКМ мимо карточки: закрываем её и передаём ПКМ тому, что под курсором (например, меню пользователя)
          e.preventDefault();
          const { clientX, clientY } = e;
          const self = e.currentTarget;
          const under = document.elementsFromPoint(clientX, clientY).find((el) => el !== self && !el.closest('.member-card'));
          onClose();
          if (under) under.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX, clientY }));
        }}
      />
      <div
        className={'member-card' + (sheet ? ' sheet' : '') + (sheet && expanded ? ' expanded' : '') + (drag ? ' dragging' : '')}
        ref={ref}
        style={
          sheet
            ? // Шторка всегда полной высоты, свёрнутая — сдвинута вниз так, что видна только карточка.
              // Разворот — сдвиг (transform), а не высота: высота перекладывала всю шторку на каждом кадре — «мало кадров».
              ((h0 === null
                ? { transform: drag > 0 ? `translateY(${drag}px)` : undefined }
                : {
                    height: 'calc(100% - env(safe-area-inset-top) - 54px)',
                    maxHeight: 'none',
                    '--sheet-y': expanded ? `${Math.max(0, drag)}px` : `calc(100% - ${h0}px + ${Math.max(0, drag)}px)`,
                  }) as React.CSSProperties)
            : pos
        }
        onTransitionEnd={(e) => {
          if (sheet && e.target === e.currentTarget && (e.propertyName === 'transform' || e.propertyName === 'height') && !expanded) setExtras(false);
        }}
        role="dialog"
        aria-label={`Профиль ${name}`}
      >
        {sheet && (
          <div className="sheet-handle" {...grab} aria-label={expanded ? 'Свернуть' : 'Развернуть'} role="button">
            <span className="sheet-grab" aria-hidden="true" />
          </div>
        )}
        <Banner name={name} {...(sheet ? grab : {})} />
        {sheet && extras && full ? (
          <div className="mc-full">{full}</div>
        ) : (
        <div className={'body' + (back ? ' from-full' : '')}>
          <span className="mc-avatar">
            <Avatar name={name} size={72} status={status} />
          </span>
          <div className="mc-identity">
            <h3 style={{ color: nameColor(name) }}>{display}</h3>
            <span className="mc-handle">
              {name} · {handleOf(name)}
            </span>
            <span className="mc-activity">
              <i className={`status-${status}`} />
              {activity}
            </span>
          </div>
          {/* «Позвонить» — только в чужой карточке */}
          {sheet && extras && !me && (
            <div className="mc-actions">
              <button type="button" className="mc-btn" onClick={onCall}>
                <Icon name="voice" size={16} />
                Позвонить
              </button>
            </div>
          )}
          <div className="mc-info">
            {profile?.bio && (
              <section>
                <div className="mc-over">О себе</div>
                <p className="mc-bio">{profile.bio}</p>
              </section>
            )}
            <section>
              <div className="mc-over">Ник на сервере</div>
              <div className="mc-value">
                {name} · {serverName}
              </div>
            </section>
            <section>
              <div className="mc-over">Роли</div>
              <div className="mc-roles">
                <span className="mc-role">
                  <i style={{ background: 'var(--role-everyone, #5c7590)' }} />
                  @everyone
                </span>
                {me && <span className="mc-role">Это вы</span>}
              </div>
            </section>
            <section>
              <div className="mc-over">На сервере с</div>
              <div className="mc-value muted">{sinceFmt.format(since).replace(' г.', '')}</div>
            </section>
          </div>
          {sheet && extras && (
            <>
              <div className="mc-info">
                <section>
                  <div className="mc-over">Общие серверы: 1</div>
                  <div className="mc-server">
                    <span className="mc-server-ico" style={{ background: serverIcon?.gradient }}>
                      {serverIcon?.short}
                    </span>
                    <span>
                      <b>{serverName}</b>
                      <small>
                        {name} · @everyone
                      </small>
                    </span>
                  </div>
                </section>
              </div>
              <div className="mc-info">
                <section>
                  <div className="mc-over">Заметка</div>
                  <textarea
                    className="mc-note"
                    rows={2}
                    value={note}
                    placeholder="Нажмите, чтобы добавить заметку. Её видите только вы"
                    onChange={(e) => saveNote(e.target.value)}
                  />
                </section>
              </div>
            </>
          )}
          {/* Своя карточка — переход к редактированию профиля. У чужих на телефоне «Профиль» не нужен:
              карточка разворачивается жестом/тапом по язычку */}
          {(me || !sheet) && (
            <div className={'mc-actions' + (sheet && extras && !me ? ' hidden' : '')}>
              <button type="button" className={'mc-btn' + (me ? ' primary' : '')} onClick={onProfile}>
                {me && <Icon name="settings" size={16} />}
                {me ? 'Редактировать профиль' : 'Профиль'}
              </button>
            </div>
          )}
        </div>
        )}
      </div>
    </Modal>
  );
}
