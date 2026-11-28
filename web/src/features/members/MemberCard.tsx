import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useUser } from '../../shared/api';
import { Icon } from '../../shared/icons';
import { handleOf, nameColor, type Status } from '../../shared/model';
import { Avatar, Banner } from '../../shared/ui/Avatar';
import { Modal } from '../../shared/ui/Modal';
import { ZoomAvatar } from '../chat/Photos';
import { dateFormat, t } from '../../shared/i18n';

const sinceFmt = dateFormat({ day: 'numeric', month: 'long', year: 'numeric' });

export function MemberCard({
  name,
  me,
  at,
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
  sheet?: boolean;
  serverIcon?: { short: string; gradient: string };
  onCall?: () => void;
  full?: ReactNode;
  at: { x: number; y: number };
  since: Date;
  serverName: string;
  onClose: () => void;
  onProfile: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const profile = useUser(name);
  const display = profile?.displayName || name;
  const [pos, setPos] = useState({ left: at.x, top: at.y });
  // Sheet: drag the top up to expand, down to collapse or close.
  const [expanded, setExpandedState] = useState(false);
  // Extra blocks appear immediately on expand and are removed only after the sheet has collapsed.
  const [extras, setExtras] = useState(false);
  // Collapsed sheet height, measured once so the animation runs between two numbers.
  const [h0, setH0] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (sheet && ref.current) setH0(ref.current.offsetHeight);
  }, [sheet]);
  const expRef = useRef(false);
  const [back, setBack] = useState(false);
  const setExpanded = (v: boolean | ((x: boolean) => boolean)) => {
    setExpandedState((x) => {
      const next = typeof v === 'function' ? v(x) : v;
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
  // The drag writes the sheet position straight to the element: a React render per pointer move lagged a frame behind the finger.
  const [dragging, setDragging] = useState(false);
  const drag = useRef(0);
  const dragFrom = useRef<number | null>(null);
  /** Travel between the collapsed and the expanded sheet, px; measured when a drag starts. */
  const range = useRef(1);
  const dragAt = useRef(0);
  // With the full profile the sheet morphs between two layers as it opens; --sheet-p is how far it is open.
  const staged = !!sheet && !!full && h0 !== null;
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
      /* ignore */
    }
  };
  const grab = {
    onPointerDown: (e: React.PointerEvent) => {
      dragFrom.current = e.clientY;
      dragAt.current = e.timeStamp;
      if (ref.current && h0 !== null) range.current = Math.max(1, ref.current.offsetHeight - h0);
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (dragFrom.current === null) return;
      drag.current = e.clientY - dragFrom.current;
      if (drag.current && !dragging) setDragging(true);
      place(drag.current);
    },
    onPointerUp: (e: React.PointerEvent) => {
      const dy = drag.current;
      const v = dy / Math.max(1, e.timeStamp - dragAt.current);
      dragFrom.current = null;
      drag.current = 0;
      setDragging(false);
      place(0);
      const far = range.current * 0.25;
      if (Math.abs(dy) < 6) setExpanded((x) => !x);
      else if (!expanded && (dy < -far || (dy < -30 && v < -0.5))) setExpanded(true);
      else if (expanded && (dy > far || (dy > 30 && v > 0.5))) setExpanded(false);
      else if (!expanded && dy > 60) onClose();
      // Released short of a threshold the sheet slides back, and onTransitionEnd drops a mounted full profile.
    },
    onPointerCancel: () => {
      dragFrom.current = null;
      drag.current = 0;
      setDragging(false);
      place(0);
    },
  };
  // Rest position for the current state; a drag moves the sheet by dy from it.
  function place(dy: number) {
    const el = ref.current;
    if (!el || !sheet) return;
    if (h0 === null) {
      el.style.transform = dy > 0 ? `translateY(${dy}px)` : '';
      return;
    }
    const open = expRef.current;
    el.style.setProperty('--sheet-y', open ? `${Math.max(0, dy)}px` : `max(0px, calc(100% - ${h0}px + ${dy}px))`);
    el.style.setProperty(
      '--sheet-p',
      String(open ? Math.max(0, 1 - Math.max(0, dy) / range.current) : Math.min(1, Math.max(0, -dy / range.current))),
    );
  }
  useLayoutEffect(() => place(drag.current), [sheet, h0, expanded]);
  useLayoutEffect(() => {
    const h = ref.current?.offsetHeight ?? 409;
    setPos({
      left: Math.max(8, Math.min(at.x, window.innerWidth - 308)),
      top: Math.max(8, Math.min(at.y, window.innerHeight - h - 8)),
    });
  }, [at.x, at.y]);
  const sinceText = sinceFmt.format(since).replace(t(' г.'), '');
  const body = (
    <div className={'body' + (back && !staged ? ' from-full' : '')}>
      <ZoomAvatar className="mc-avatar" url={profile?.avatar}>
        <Avatar name={name} size={72} status={status} />
      </ZoomAvatar>
      <div className="mc-identity">
        <h3 style={{ color: nameColor(name) }}>{display}</h3>
        <span className="mc-handle">
          {display} · {handleOf(name)}
        </span>
      </div>
      {sheet && extras && !full && !me && (
        <div className="mc-actions">
          <button type="button" className="mc-btn" onClick={onCall}>
            <Icon name="voice" size={20} />
            {t('Позвонить')}
          </button>
        </div>
      )}
      <div className="mc-info">
        <section>
          <div className="mc-over">{t('Роли')}</div>
          <div className="mc-roles">
            <span className="mc-role">
              <i style={{ background: 'var(--role-everyone, #5c7590)' }} />
              @everyone
            </span>
          </div>
        </section>
        <section>
          <div className="mc-over">{t('На сервере с')}</div>
          <div className="mc-value muted">{sinceText}</div>
        </section>
      </div>
      {sheet && extras && !full && (
        <>
          <div className="mc-info">
            <section>
              <div className="mc-over">{t('Общие серверы: 1')}</div>
              <div className="mc-server">
                <span className="mc-server-ico" style={{ background: serverIcon?.gradient }}>
                  {serverIcon?.short}
                </span>
                <span>
                  <b>{serverName}</b>
                  <small>
                    {display} · @everyone
                  </small>
                </span>
              </div>
            </section>
          </div>
          <div className="mc-info">
            <section>
              <div className="mc-over">{t('Заметка')}</div>
              <textarea
                className="mc-note"
                rows={2}
                value={note}
                placeholder={t('Нажмите, чтобы добавить заметку. Её видите только вы')}
                onChange={(e) => saveNote(e.target.value)}
              />
            </section>
          </div>
        </>
      )}
      {(me || !sheet) && (
        <div className={'mc-actions' + (sheet && extras && !full && !me ? ' hidden' : '')}>
          {/* On the phone sheet the full profile is the expanded sheet itself. */}
          <button type="button" className="mc-btn" onClick={sheet && staged ? () => setExpanded(true) : onProfile}>
            {t('Профиль')}
          </button>
        </div>
      )}
    </div>
  );
  return (
    <Modal onClose={onClose}>
      <div
        className="popover-backdrop"
        onClick={onClose}
        onContextMenu={(e) => {
          // Right click outside the card: close it and pass the click to whatever is under the cursor (e.g. the user menu).
          e.preventDefault();
          const { clientX, clientY } = e;
          const self = e.currentTarget;
          const under = document.elementsFromPoint(clientX, clientY).find((el) => el !== self && !el.closest('.member-card'));
          onClose();
          if (under) under.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX, clientY }));
        }}
      />
      <div
        className={'member-card' + (sheet ? ' sheet' : '') + (staged ? ' staged' : '') + (staged && expanded ? ' open' : '') + (sheet && expanded ? ' expanded' : '') + (dragging ? ' dragging' : '')}
        ref={ref}
        style={
          sheet
            ? // The sheet is always full height; collapsed it is shifted down so only the card shows.
              // Expanding moves it with transform, not height: animating height relaid the whole sheet every frame.
              // --sheet-y and --sheet-p are written by place().
              h0 === null
              ? undefined
              : { height: 'calc(100% - env(safe-area-inset-top) - 54px)', maxHeight: 'none' }
            : pos
        }
        onTransitionEnd={(e) => {
          if (sheet && e.target === e.currentTarget && (e.propertyName === 'transform' || e.propertyName === 'height') && !expanded) setExtras(false);
        }}
        role="dialog"
        aria-label={t('Профиль {0}', { 0: name })}
      >
        {sheet && (
          <div className="sheet-handle" {...grab} aria-label={expanded ? t('Свернуть') : t('Развернуть')} role="button">
            <span className="sheet-grab" aria-hidden="true" />
          </div>
        )}
        <Banner name={name} {...(sheet ? grab : {})} />
        {staged ? (
          <div className="mc-stack">
            {body}
            {/* Mounted from the start: a layer mounted already open would appear without its transition. */}
            <div className="mc-full">{full}</div>
          </div>
        ) : sheet && extras && full ? (
          <div className="mc-full">{full}</div>
        ) : (
          body
        )}
      </div>
    </Modal>
  );
}
