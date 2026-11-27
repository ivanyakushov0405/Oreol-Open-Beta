import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { paths } from '../../app/router';
import type { AppState } from '../../app/useAppState';
import { Icon, type IconName } from '../../shared/icons';
import { Avatar } from '../../shared/ui/Avatar';
import { firstPhotoUrl, previewText, REACTIONS, type Channel, type ChatMessage } from '../../shared/model';
import { DisplayName } from '../members/Nick';
import { useOpenChat } from '../notifications/notifications';
import { Composer } from './Composer';
import { MessageList } from './MessageList';
import { copyPhoto, prefetchPhoto, savePhoto, touchDevice } from './Photos';
import { dateFormat, plural, t } from '../../shared/i18n';

type Chat = AppState['general'];
type Id = number | string;

export function PinnedButton({ chat, className = 'icon-btn' }: { chat: Chat; className?: string }) {
  const on = chat.view === 'pinned';
  return (
    <button
      className={className + (on ? ' active' : '')}
      title={on ? t('Вернуться к чату') : t('Закреплённые')}
      aria-label={t('Закреплённые')}
      aria-pressed={on}
      onClick={() => chat.setView(on ? 'all' : 'pinned')}
    >
      <Icon name={on ? 'pin-fill' : 'pin'} />
      {chat.pinned.length > 0 && <span className="pin-count">{chat.pinned.length}</span>}
    </button>
  );
}

interface MenuItem {
  icon: IconName;
  label: string;
  danger?: boolean;
  flip?: boolean;
  tail?: boolean;
  page?: 'delete';
  run: () => void;
}
interface DeleteAsk {
  mine: boolean;
  run: (scope: 'me' | 'all') => void;
}

const readTimeFmt = dateFormat({ hour: '2-digit', minute: '2-digit' });
const readDayFmt = dateFormat({ day: 'numeric', month: 'short' });
function readWhen(iso: string | null) {
  if (!iso) return '';
  const d = new Date(iso);
  const hm = readTimeFmt.format(d);
  const today = new Date();
  const y = new Date();
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return t('сегодня в {0}', { 0: hm });
  if (d.toDateString() === y.toDateString()) return t('вчера в {0}', { 0: hm });
  return t('{0} в {1}', { 0: readDayFmt.format(d), 1: hm });
}

type Reads = { user: string; at: string | null }[] | null;
function useReads(src?: { room: string; id: Id }) {
  const [reads, setReads] = useState<Reads>(null);
  const room = src?.room;
  const id = src?.id;
  useEffect(() => {
    if (!room || id == null) return;
    let alive = true;
    fetch(`/api/chat/${encodeURIComponent(room)}/reads/${encodeURIComponent(String(id))}`)
      .then((r) => (r.ok ? r.json() : { reads: [] }))
      .then((d) => alive && setReads(d.reads ?? []))
      .catch(() => alive && setReads([]));
    return () => {
      alive = false;
    };
  }, [room, id]);
  return reads;
}

function ReadsList({ reads }: { reads: NonNullable<Reads> }) {
  return (
    <div className="mm-reads-list">
      {reads.map((r) => (
        <div key={r.user} className="mm-read">
          <Avatar name={r.user} size={32} />
          <span className="mm-read-text">
            <span className="mm-read-name">
              <DisplayName name={r.user} />
            </span>
            <span className="mm-read-at">{r.at ? readWhen(r.at) : t('прочитано до записи времени')}</span>
          </span>
          <Icon name="check-double" size={18} className="mm-read-tick" />
        </div>
      ))}
    </div>
  );
}

function MessageMenu({
  x,
  y,
  row,
  lift,
  readsOf,
  del,
  items,
  react,
  onClose,
}: {
  x: number;
  y: number;
  row?: HTMLElement;
  lift?: boolean;
  readsOf?: { room: string; id: Id };
  del?: DeleteAsk;
  items: MenuItem[];
  react?: { mine: string[]; pick: (emoji: string) => void };
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const reads = useReads(readsOf);
  const [page, setPage] = useState<'main' | 'reads' | 'delete'>('main');
  const [width, setWidth] = useState<number | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number; maxH?: number; origin: string }>({ left: x, top: y, origin: 'top left' });
  const focus = !!lift && !!row;
  /** The finger that held the message is released over the menu; that release must not trigger an item. */
  const armed = useRef(!focus);
  // Keep the menu on screen and off the message: right below it, or above when there is no room below.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const pad = 8;
    const gap = 6;
    if (row) {
      // The pressed row is squeezed around its centre, possibly still mid-way. Undo that squeeze in the measurements and
      // start the clone from the same scale, so the copy takes over without a jump.
      const tf = getComputedStyle(row).transform;
      const k = focus && tf && tf !== 'none' ? new DOMMatrixReadOnly(tf).a || 1 : 1;
      const vr = row.getBoundingClientRect();
      const cx = vr.left + vr.width / 2;
      const cy = vr.top + vr.height / 2;
      const unsqueeze = (b: DOMRect) => {
        const left = cx + (b.left - cx) / k;
        const top = cy + (b.top - cy) / k;
        return { left, top, right: left + b.width / k, bottom: top + b.height / k, width: b.width / k, height: b.height / k };
      };
      const r = unsqueeze(vr);
      const bubbleEl = row.querySelector('.bubble, .sys-note') as HTMLElement | null;
      const bubble = bubbleEl ? unsqueeze(bubbleEl.getBoundingClientRect()) : r;
      const box = host.current;
      if (focus && box) {
        box.replaceChildren();
        const clone = row.cloneNode(true) as HTMLElement;
        clone.removeAttribute('data-pressing');
        clone.style.cssText = '';
        // Full width of the clone, otherwise a service-row button shrinks to its content and drifts left.
        clone.style.width = '100%';
        // A lazy copy of an already shown photo is decoded again and blinks; decode it with the first frame.
        for (const img of clone.querySelectorAll('img')) {
          img.loading = 'eager';
          img.decoding = 'sync';
        }
        // Keep the list classes (bubble colors depend on them) but drop the list's own layout.
        const scroll = document.createElement('div');
        scroll.className = 'chat-scroll';
        scroll.style.cssText = 'all: unset; display: block';
        // The own-message gradient is computed from the list height (--vh/--by/--bh); without them only the top strip
        // of the cloned bubble was painted.
        const cs = getComputedStyle(row.querySelector('.bubble') ?? row);
        for (const v of ['--vh', '--by', '--bh']) {
          const val = cs.getPropertyValue(v);
          if (val) scroll.style.setProperty(v, val);
        }
        scroll.style.setProperty('--lift-from', String(k));
        scroll.appendChild(clone);
        box.appendChild(scroll);
        box.style.left = `${r.left}px`;
        box.style.width = `${r.width}px`;
        box.style.top = `${r.top}px`;
        // Hide the original under the blur so the clone is the only message on screen, but only once the clone's photos
        // are decoded: until then the original, exactly underneath, fills in for them instead of a blank frame.
        const imgs = [...clone.querySelectorAll('img')];
        const hide = () => {
          if (clone.isConnected) row.style.visibility = 'hidden';
        };
        if (!imgs.length) hide();
        else void Promise.all(imgs.map((i) => i.decode().catch(() => undefined))).then(hide);
      }
      const mine = row.classList.contains('mine');
      const want = focus ? (mine ? bubble.right - w : bubble.left) : Math.min(Math.max(x - 24, bubble.left), Math.max(bubble.left, bubble.right - w));
      const left = Math.max(pad, Math.min(want, innerWidth - w - pad));
      const spaceBelow = innerHeight - pad - (bubble.bottom + gap);
      const spaceAbove = bubble.top - gap - pad;
      const below = spaceBelow >= h || (spaceBelow >= spaceAbove && spaceBelow >= 160);
      const origin = `${below ? 'top' : 'bottom'} ${mine ? 'right' : 'left'}`;
      if (below) return setPos({ left, top: bubble.bottom + gap, maxH: spaceBelow, origin });
      // Above the message the menu is anchored by its bottom edge, so pages grow upward instead of over the message.
      if (spaceAbove >= h) return setPos({ left, bottom: innerHeight - bubble.top + gap, maxH: spaceAbove, origin });
      // A tall message on a short screen (landscape phone, photo): place the menu beside the bubble if it fits.
      const side = mine ? bubble.left - gap - w : bubble.right + gap;
      if (side >= pad && side + w <= innerWidth - pad) {
        const st = Math.max(pad, Math.min(bubble.top, innerHeight - h - pad));
        return setPos({ left: side, top: st, maxH: innerHeight - st - pad, origin: `top ${mine ? 'right' : 'left'}` });
      }
      if (spaceAbove >= Math.min(h, 160) || !focus) return setPos({ left, bottom: innerHeight - bubble.top + gap, maxH: Math.max(spaceAbove, 120), origin });
      // A long message on a phone: pin the menu to the bottom and fit as much of the message above it as possible.
      const top = innerHeight - h - pad;
      if (box) box.style.top = `${Math.max(pad, Math.min(r.top, top - gap - r.height))}px`;
      setPos({ left, top, maxH: h, origin });
      return;
    }
    const up = y + h + pad > innerHeight;
    const left = Math.max(pad, Math.min(x, innerWidth - w - pad));
    const top = Math.max(pad, up ? y - h : y);
    setPos({ left, top, origin: `${up ? 'bottom' : 'top'} ${left < x - w / 2 ? 'right' : 'left'}` });
    // Once read receipts load the menu changes width; re-measure so it stays on screen.
  }, [x, y, row, focus, !!reads]);
  useEffect(
    () =>
      focus && row
        ? () => {
            row.style.removeProperty('visibility');
          }
        : undefined,
    [row, focus],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  /** Window size before the page switch, so the new page grows from it instead of jumping. */
  const before = useRef<DOMRect | null>(null);
  const go = (to: 'main' | 'reads' | 'delete') => {
    if (ref.current) {
      before.current = ref.current.getBoundingClientRect();
      if (to !== 'main') setWidth(ref.current.offsetWidth);
    }
    setPage(to);
  };
  useLayoutEffect(() => {
    const el = ref.current;
    const old = before.current;
    before.current = null;
    if (!el || !old) return;
    const now = el.getBoundingClientRect();
    // Anchored to the bubble's right edge (own message), the menu keeps that edge fixed and stays on screen.
    const right = pos.origin.endsWith('right');
    const left = Math.max(8, Math.min(right ? old.right - now.width : old.left, innerWidth - now.width - 8));
    if (Math.abs(left - now.left) > 0.5) setPos((p) => ({ ...p, left }));
    if (Math.abs(old.height - now.height) < 1 && Math.abs(old.width - now.width) < 1) return;
    el.animate(
      [
        { height: `${old.height}px`, width: `${old.width}px` },
        { height: `${now.height}px`, width: `${now.width}px` },
      ],
      { duration: 240, easing: 'cubic-bezier(.2, .8, .2, 1)' },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);
  const main = items.filter((it) => !it.tail);
  const tail = items.filter((it) => it.tail);
  const button = (it: MenuItem) => (
    <button
      key={it.label}
      role="menuitem"
      className={'msg-menu-item' + (it.danger ? ' danger' : '')}
      onPointerDown={() => (armed.current = true)}
      onClick={() => {
        if (!armed.current) return;
        if (it.page) return go(it.page);
        onClose();
        it.run();
      }}
    >
      <Icon name={it.icon} size={18} className={it.flip ? 'flip' : undefined} />
      <span>{it.label}</span>
    </button>
  );
  return createPortal(
    <>
      <div
        className={'msg-menu-backdrop' + (focus ? ' msg-focus' : '')}
        onPointerDown={() => (armed.current = true)}
        onClick={() => armed.current && onClose()}
        onContextMenu={(e) => (e.preventDefault(), onClose())}
      />
      {focus && <div ref={host} className="msg-focus-host" aria-hidden="true" onClick={() => armed.current && onClose()} />}
      <div
        ref={ref}
        className={'msg-menu' + (focus ? ' focus' : '')}
        role="menu"
        style={{
          left: pos.left,
          top: pos.top,
          bottom: pos.bottom,
          transformOrigin: pos.origin,
          maxHeight: pos.maxH ?? 'calc(100dvh - 16px)',
          overflowY: 'auto',
          minWidth: page !== 'main' && width ? Math.max(width, 260) : undefined,
          maxWidth: page === 'delete' && width ? Math.max(width, 280) : undefined,
        }}
      >
        {page === 'main' ? (
          <div className={'mm-page' + (width ? ' anim' : '')} key="main">
            {react && (
              <>
                <div className="mm-reacts" role="group" aria-label={t('Реакции')}>
                  {REACTIONS.map((e) => (
                    <button
                      key={e}
                      type="button"
                      className={'mm-react' + (react.mine.includes(e) ? ' on' : '')}
                      aria-label={t('Реакция {0}', { 0: e })}
                      onPointerDown={() => (armed.current = true)}
                      onClick={() => {
                        if (!armed.current) return;
                        onClose();
                        react.pick(e);
                      }}
                    >
                      {e}
                    </button>
                  ))}
                </div>
                <div className="msg-menu-sep" />
              </>
            )}
            {readsOf && (
              <>
                <button
                  type="button"
                  className="msg-menu-item mm-reads-btn"
                  disabled={!reads?.length}
                  onPointerDown={() => (armed.current = true)}
                  onClick={() => armed.current && reads?.length && go('reads')}
                >
                  <Icon name={reads?.length ? 'check-double' : 'check'} size={18} />
                  <span>{!reads ? t('Загружаем…') : reads.length ? t('Прочитали: {0}', { 0: reads.length }) : t('Ещё никто не прочитал')}</span>
                  {!!reads?.length && <Icon name="chevron-right" size={16} className="mm-chev" />}
                </button>
                <div className="msg-menu-sep" />
              </>
            )}
            {main.map(button)}
            {tail.length > 0 && main.length > 0 && <div className="msg-menu-sep" />}
            {tail.map(button)}
          </div>
        ) : page === 'delete' && del ? (
          <div className="mm-page mm-page-reads anim" key="delete">
            <button type="button" className="msg-menu-item mm-back" onClick={() => go('main')}>
              <Icon name="back" size={18} />
              <span>{t('Удалить сообщение?')}</span>
            </button>
            <div className="msg-menu-sep" />
            <p className="mm-del-text">
              {del.mine ? t('Можно убрать только у себя или удалить у всех участников чата.') : t('Чужое сообщение можно убрать только у себя, у остальных оно останется.')}
            </p>
            {del.mine && (
              <button type="button" className="msg-menu-item danger" onClick={() => (onClose(), del.run('all'))}>
                <Icon name="users" size={18} />
                <span>{t('Удалить у всех')}</span>
              </button>
            )}
            <button type="button" className="msg-menu-item danger" onClick={() => (onClose(), del.run('me'))}>
              <Icon name="user" size={18} />
              <span>{t('Удалить у меня')}</span>
            </button>
            <div className="msg-menu-sep" />
            <button type="button" className="msg-menu-item" onClick={() => go('main')}>
              <Icon name="close" size={18} />
              <span>{t('Отмена')}</span>
            </button>
          </div>
        ) : (
          <div className="mm-page mm-page-reads anim" key="reads">
            <button type="button" className="msg-menu-item mm-back" onClick={() => go('main')}>
              <Icon name="back" size={18} />
              <span>{t('Прочитали: ')}{reads?.length ?? 0}</span>
            </button>
            <div className="msg-menu-sep" />
            {reads && <ReadsList reads={reads} />}
          </div>
        )}
      </div>
    </>,
    document.body,
  );
}

function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div className="chat-modal-wrap" onClick={onClose}>
      <div className="chat-modal" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="chat-modal-head">
          <b>{title}</b>
          <button className="icon-btn" title={t('Закрыть')} onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

const msgs = (n: number) => plural(n, 'сообщение', 'сообщения', 'сообщений');

/** The selection actions in the composer's place and shape, so the list keeps running under it. */
function SelectBar({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const box = el?.parentElement;
    if (!el || !box) return;
    const set = () => box.style.setProperty('--composer-h', `${el.offsetHeight}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => {
      ro.disconnect();
      box.style.removeProperty('--composer-h');
    };
  }, []);
  return (
    <div ref={ref} className="composer sel-mode">
      {children}
    </div>
  );
}

/** The last search jump already shown, shared by every mount of the chat view. */
let jumpDone = 0;

export function ChatBody({ app, chat, channel, compact }: { app: AppState; chat: Chat; channel: Channel; compact?: boolean }) {
  const cls = 'chat' + (app.glassChat ? ' transparent' : '');
  const title = channel.kind === 'voice' ? t('чат «{0}»', { 0: channel.name }) : `#${channel.name}`;
  const me = app.name;
  const mentionPeople = useMemo(() => app.members.map((m) => m.username).filter((n) => n !== me), [app.members, me]);
  useOpenChat(channel.room);

  const [menu, setMenu] = useState<{ m: ChatMessage; x: number; y: number; row?: HTMLElement; lift?: boolean; photo?: string } | null>(null);
  const [reply, setReply] = useState<ChatMessage | null>(null);
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  const [seed, setSeed] = useState<{ key: number; text: string | null } | null>(null);
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [del, setDel] = useState<Id[] | null>(null);
  const [fwd, setFwd] = useState<Id[] | null>(null);
  const [focus, setFocus] = useState<{ id: Id; n: number } | null>(null);
  const pinnedView = chat.view === 'pinned';

  useEffect(() => {
    setMenu(null);
    setReply(null);
    setEditing(null);
    setSelected(null);
    setDel(null);
    setFwd(null);
  }, [channel.room]);

  const byId = useMemo(() => new Map(chat.messages.map((m) => [String(m.id), m])), [chat.messages]);
  useEffect(() => {
    if (reply && !byId.has(String(reply.id))) setReply(null);
    if (editing && !byId.has(String(editing.id))) setEditing(null);
    if (selected) {
      const next = new Set([...selected].filter((id) => byId.has(id)));
      if (next.size !== selected.size) setSelected(next);
    }
  }, [byId]); // eslint-disable-line react-hooks/exhaustive-deps

  const seedText = (text: string | null) => setSeed({ key: Date.now(), text });
  const draft = useRef('');
  const stash = useRef('');
  const startReply = (m: ChatMessage) => {
    seedText(editing ? stash.current : null);
    setEditing(null);
    setReply(m);
  };
  const startEdit = (m: ChatMessage) => {
    if (!editing) stash.current = draft.current;
    setReply(null);
    setEditing(m);
    seedText(m.content);
  };
  const cancelBar = () => {
    if (editing) seedText(stash.current);
    setReply(null);
    setEditing(null);
  };
  // The Clipboard API needs focus and HTTPS; otherwise copy through a hidden textarea.
  const copyLegacy = (text: string) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  };
  const copy = (text: string) => {
    const done = (ok: boolean) => app.notify(ok ? t('Скопировано') : t('Не удалось скопировать'), ok ? 'success' : 'error');
    if (!navigator.clipboard) return done(copyLegacy(text));
    navigator.clipboard.writeText(text).then(
      () => done(true),
      () => done(copyLegacy(text)),
    );
  };
  const jump = (id: Id) => {
    if (!byId.has(String(id))) {
      app.notify(t('Сообщение слишком старое, его нет в загруженной истории'));
      return;
    }
    if (pinnedView) chat.setView('all');
    setFocus({ id, n: Date.now() });
  };
  useEffect(() => {
    const req = chat.jumpReq;
    // The request outlives this view; reopening the chat must not jump to the found message again.
    if (!req || req.n <= jumpDone) return;
    jumpDone = req.n;
    setFocus({ id: req.id, n: Date.now() });
  }, [chat.jumpReq]);
  /** Once the select bar has replaced the input, bring the chosen message to the middle of what stays visible. */
  const centerRow = (id: Id) =>
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const root = rootRef.current;
        const el = root?.querySelector<HTMLElement>('.chat-scroll');
        const row = el?.querySelector<HTMLElement>(`:scope > [data-mid="${CSS.escape(String(id))}"]`);
        if (!root || !el || !row) return;
        const box = el.getBoundingClientRect();
        const bar = root.querySelector<HTMLElement>(':scope > .composer');
        const bottom = bar ? Math.min(box.bottom, bar.getBoundingClientRect().top) : box.bottom;
        // On the phone the list also runs under the screen head.
        const head = root.closest('.m-full')?.querySelector<HTMLElement>(':scope > .m-head');
        const top = head ? Math.max(box.top, head.getBoundingClientRect().bottom) : box.top;
        const r = row.getBoundingClientRect();
        el.scrollBy({ top: r.top + r.height / 2 - (top + bottom) / 2, behavior: 'smooth' });
      }),
    );
  const toggle = (m: ChatMessage) =>
    setSelected((s) => {
      const next = new Set(s ?? []);
      const k = String(m.id);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  const selList = (selected ? chat.messages.filter((m) => selected.has(String(m.id))) : []) as ChatMessage[];

  const photoItems = (url: string): MenuItem[] => {
    const saved = (res: 'ok' | 'cancel' | 'fail') => res === 'fail' && app.notify(t('Не удалось сохранить фото'), 'error');
    // Phones only get Save (the system share sheet has "Save image").
    if (touchDevice()) return [{ icon: 'download', label: t('Сохранить фото'), run: () => void savePhoto(url, false).then(saved) }];
    return [
      {
        icon: 'copy',
        label: t('Копировать изображение'),
        run: () => void copyPhoto(url).then((ok) => app.notify(ok ? t('Изображение скопировано') : t('Не удалось скопировать'), ok ? 'success' : 'error')),
      },
      { icon: 'download', label: t('Сохранить как…'), run: () => void savePhoto(url, true).then(saved) },
    ];
  };
  // Pin notes and the pinned list are not selectable: no multi-select there.
  const selectItem = (m: ChatMessage): MenuItem[] =>
    pinnedView || m.sys ? [] : [{ icon: 'check', label: t('Выделить'), run: () => {
            setSelected(new Set([String(m.id)]));
            centerRow(m.id);
          } }];
  const menuItems = (m: ChatMessage, photo?: string): MenuItem[] => {
    if (m.sys) {
      return [
        ...selectItem(m),
        { icon: 'trash', label: t('Удалить'), danger: true, tail: true, page: 'delete', run: () => setDel([m.id]) },
      ];
    }
    const mine = m.user === me;
    const items: MenuItem[] = [{ icon: 'reply', label: t('Ответить'), run: () => startReply(m) }];
    if (mine) items.push({ icon: 'pencil', label: t('Изменить'), tail: true, run: () => startEdit(m) });
    items.push(
      ...(m.content ? [{ icon: 'copy' as IconName, label: t('Копировать текст'), run: () => copy(m.content) }] : []),
      ...(photo ? photoItems(photo) : []),
      { icon: m.pinned ? 'pin-off' : 'pin', label: m.pinned ? t('Открепить') : t('Закрепить'), run: () => chat.pin(m.id, !m.pinned) },
      { icon: 'reply', label: t('Переслать'), flip: true, run: () => setFwd([m.id]) },
      ...selectItem(m),
      { icon: 'trash', label: t('Удалить'), danger: true, tail: true, page: 'delete', run: () => setDel([m.id]) },
    );
    return items;
  };

  const delMine = del ? del.every((id) => byId.get(String(id))?.user === me) : false;
  const doDelete = (scope: 'me' | 'all') => {
    if (!del) return;
    chat.remove(del, scope);
    setDel(null);
    setSelected(null);
  };

  const targets = app.servers.flatMap((s) =>
    s.channels.map((c) => ({
      room: c.room,
      server: s,
      channel: c,
      label: c.kind === 'voice' ? t('Чат «{0}»', { 0: c.name }) : `#${c.name}`,
      icon: (c.kind === 'voice' ? 'voice' : 'chats') as IconName,
    })),
  );
  const doForward = (to: (typeof targets)[number]) => {
    if (!fwd) return;
    const ids = [...fwd].sort((a, b) => Number(a) - Number(b));
    const label = `${to.server.name} · ${to.label}`;
    chat.forward(ids, to.room, (_to, count) => {
      app.notify(count ? t('Переслано: {0} → {1}', { 0: msgs(count), 1: label }) : t('Не удалось переслать'), count ? 'success' : 'error');
      // Forwarded to another chat: navigate through the URL, which both desktop and mobile layouts parse.
      if (!count || to.room === channel.room) return;
      const url = paths.channel(to.server.id, to.channel.id, to.channel.kind === 'voice');
      if (location.pathname === url) return;
      history.pushState({ prev: location.pathname }, '', url);
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    setFwd(null);
    setSelected(null);
  };

  const replyTarget = reply ?? editing;
  const bar = replyTarget ? (
    <div className="composer-bar">
      <Icon name={editing ? 'pencil' : 'reply'} size={18} />
      {firstPhotoUrl(replyTarget.attachments) && <img className="rq-thumb" src={firstPhotoUrl(replyTarget.attachments)} alt="" draggable={false} />}
      <button type="button" className="cb-text" onClick={() => jump(replyTarget.id)}>
        <b>{editing ? t('Редактирование') : <>{t('Ответ ')}<DisplayName name={replyTarget.user} /></>}</b>
        <span>{previewText(replyTarget)}</span>
      </button>
      <button type="button" className="icon-btn" title={t('Отменить')} onClick={cancelBar}>
        <Icon name="close" size={18} />
      </button>
    </div>
  ) : null;

  const list = pinnedView ? chat.pinned : chat.messages;

  const lastId = chat.messages.length ? chat.messages[chat.messages.length - 1].id : 0;
  // Read up to the newest message that has been on screen, so leaving halfway keeps the rest unread.
  const seen = useRef(0);
  const onSeen = (id: number) => {
    if (id <= seen.current) return;
    seen.current = id;
    if (document.visibilityState === 'visible') chat.markRead(id);
  };
  useEffect(() => {
    seen.current = 0;
  }, [channel.room]);
  useEffect(() => {
    const mark = () => document.visibilityState === 'visible' && seen.current && chat.markRead(seen.current);
    document.addEventListener('visibilitychange', mark);
    return () => document.removeEventListener('visibilitychange', mark);
  }, [chat.markRead]); // eslint-disable-line react-hooks/exhaustive-deps
  // A mark made while the socket was reconnecting was dropped: send it once the socket is back.
  useEffect(() => {
    if (chat.connected && seen.current && document.visibilityState === 'visible') chat.markRead(seen.current);
  }, [chat.connected]); // eslint-disable-line react-hooks/exhaustive-deps
  const readUpTo = Object.entries(chat.reads).reduce((acc, [u, id]) => (u !== me && id > acc ? id : acc), 0);
  // The "New" divider: what was read when the chat opened, fixed once when history arrives.
  // Computed during render, not in an effect: otherwise the list first rendered without the divider
  // and everything below jumped a frame later.
  // If everything was read and the chat is visible, the mark follows new messages:
  // a message arriving in an open chat is already read and needs no divider.
  const [mark, setMark] = useState<{ room: string; id: number; line: boolean } | null>(null);
  let newAfter = mark?.room === channel.room ? mark.id : 0;
  if (mark?.room !== channel.room && chat.room === channel.room) {
    newAfter = chat.myRead;
    const line = chat.messages.some((m) => !m.sys && m.user !== me && Number(m.id) > chat.myRead);
    setMark({ room: channel.room, id: chat.myRead, line });
  } else if (mark && mark.room === channel.room && !mark.line && Number(lastId) > mark.id) {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      newAfter = Number(lastId);
      setMark({ ...mark, id: Number(lastId) });
    } else setMark({ ...mark, line: true });
  }

  // Pinned banner: the latest pin not below the current scroll position.
  const rootRef = useRef<HTMLDivElement>(null);
  const [viewPin, setViewPin] = useState(0);
  const pins = chat.pinned;
  let pinIdx = pins.findIndex((p) => Number(p.id) === viewPin);
  if (pinIdx < 0 && pins.length) {
    // None in the loaded list: the latest pin is older than loaded history, otherwise the first one.
    const firstLoaded = chat.messages.length ? Number(chat.messages[0].id) : Infinity;
    pins.forEach((p, i) => {
      if (Number(p.id) < firstLoaded) pinIdx = i;
    });
    if (pinIdx < 0) pinIdx = 0;
  }
  const shownPin = pinIdx >= 0 ? pins[pinIdx] : null;
  const showBanner = !!shownPin && !pinnedView && !selected;
  const isOnScreen = (id: Id) => {
    const root = rootRef.current;
    const scroll = root?.querySelector<HTMLElement>('.chat-scroll');
    const row = scroll?.querySelector<HTMLElement>(`[data-mid="${CSS.escape(String(id))}"]`);
    if (!scroll || !row) return false;
    const cs = getComputedStyle(scroll);
    const a = scroll.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    return r.bottom > a.top + parseFloat(cs.paddingTop) && r.top < a.bottom - parseFloat(cs.paddingBottom);
  };
  const lastPinJump = useRef<Id | null>(null);
  // Tap: jump to the shown pin; if already there and on screen, jump to the previous one (cyclic).
  const openPin = () => {
    if (!shownPin) return;
    const again = String(lastPinJump.current) === String(shownPin.id) && isOnScreen(shownPin.id);
    const target = again && pins.length > 1 ? pins[(pinIdx - 1 + pins.length) % pins.length] : shownPin;
    lastPinJump.current = target.id;
    setViewPin(Number(target.id));
    jump(target.id);
  };
  // Numbered in order: the oldest pin is #1.
  const pinNo = pinIdx + 1;
  const banner = showBanner ? (
    <div className="pin-banner">
      {pins.length > 4 ? (
        <>
          <span className="pb-count" title={t('Закреп {0} из {1}', { 0: pinNo, 1: pins.length })}>{pinNo}</span>
          <span className="pb-bars" aria-hidden="true">
            <i className="on" />
          </span>
        </>
      ) : pins.length > 1 ? (
        <span className="pb-bars" aria-hidden="true">
          {pins.map((p, i) => (
            <i key={p.id} className={i === pinIdx ? 'on' : ''} />
          ))}
        </span>
      ) : null}
      {firstPhotoUrl(shownPin.attachments) && (
        <img className="rq-thumb pb-thumb" src={firstPhotoUrl(shownPin.attachments)} alt="" draggable={false} onClick={openPin} />
      )}
      <button type="button" className="pb-body" onClick={openPin} title={t('Перейти к сообщению')}>
        <b>{t('Закреплённое сообщение')}</b>
        <span>
          {shownPin.fwd ? <>{t('Переслано от ')}<DisplayName name={shownPin.fwd.user} />: </> : null}
          {previewText(shownPin)}
        </span>
      </button>
      <button type="button" className="icon-btn pb-unpin" title={t('Открепить')} aria-label={t('Открепить сообщение')} onClick={() => chat.pin(shownPin.id, false)}>
        <Icon name="pin-off" size={18} />
      </button>
    </div>
  ) : null;

  return (
    <div ref={rootRef} className={cls + (selected ? ' is-selecting' : '') + (showBanner ? ' with-pin' : '')}>
      {banner}
      <MessageList
        key={pinnedView ? 'pinned' : 'all'}
        messages={list}
        room={channel.room}
        me={me}
        more={!pinnedView && chat.hasMore}
        loadingOlder={chat.loadingOlder}
        onOlder={pinnedView ? undefined : () => void chat.loadOlder()}
        empty={
          pinnedView ? (
            <>
              <b>{t('Закреплённых пока нет')}</b>
              {t('Закрепите важное сообщение через меню по правой кнопке или долгому нажатию.')}
            </>
          ) : (
            <>
              <b>{chat.connected ? t('Добро пожаловать в {0}', { 0: title }) : t('Подключаемся к чату…')}</b>
              {chat.connected && t('Сообщений пока нет. Напишите первым')}
            </>
          )
        }
        onMenu={(m, x, y, row, lift) => {
          const img = document.elementFromPoint(x, y)?.closest('img');
          const urls = (m.attachments ?? []).filter((a) => !a.video && !a.file).map((a) => a.url);
          const hit = img ? urls.find((u) => img.src.endsWith(u) || img.src === u) : undefined;
          const photo = hit ?? urls[0];
          if (photo && touchDevice()) prefetchPhoto(photo);
          setMenu({ m, x, y, row, lift, photo });
        }}
        onReply={startReply}
        onReact={(m, e) => !m.sys && chat.react(m.id, e)}
        selecting={!!selected}
        selected={selected ?? undefined}
        onToggle={toggle}
        onJump={jump}
        focus={focus}
        readUpTo={readUpTo}
        newAfter={pinnedView ? 0 : newAfter}
        onView={setViewPin}
        onSeen={pinnedView ? undefined : onSeen}
      />
      {selected ? (
        <SelectBar>
          <button type="button" className="round" title={t('Отменить выделение')} onClick={() => setSelected(null)}>
            <Icon name="close" />
          </button>
          <div className="field sb-field">
          <span className="sb-count">{selected.size ? t('Выбрано: {0}', { 0: selected.size }) : t('Выберите сообщения')}</span>
          <button className="sb-act" disabled={!selected.size} title={t('Копировать')} onClick={() => {
            copy(selList.map((m) => (selList.length > 1 ? `${m.user}: ${previewText(m)}` : previewText(m))).join('\n'));
            setSelected(null);
          }}>
            <Icon name="copy" />
          </button>
          <button className="sb-act" disabled={!selected.size || selList.some((m) => m.sys)} title={selList.some((m) => m.sys) ? t('Строки о закрепе не пересылаются') : t('Переслать')} onClick={() => setFwd(selList.map((m) => m.id))}>
            <Icon name="reply" className="flip" />
          </button>
          <button className="sb-act danger" disabled={!selected.size} title={t('Удалить')} onClick={() => setDel(selList.map((m) => m.id))}>
            <Icon name="trash" />
          </button>
          </div>
        </SelectBar>
      ) : pinnedView ? (
        <div className="composer pinned-bar">
          <Icon name="pin-fill" size={18} />
          <span className="sb-count">{t('Закреплённые · ')}{chat.pinned.length}</span>
          <button className="btn-chip" onClick={() => chat.setView('all')}>
            {t('К чату')}
          </button>
        </div>
      ) : (
        <Composer
          placeholder={compact ? t('Сообщение') : t('Написать в {0}', { 0: title })}
          bar={bar}
          seed={seed}
          onCancel={replyTarget ? cancelBar : undefined}
          onDraft={(t) => (draft.current = t)}
          allowPhotos={!editing}
          people={mentionPeople}
          onError={(t) => app.notify(t, 'error')}
          onSend={(text, photos) => {
            if (editing) {
              const t = text.trim();
              if (!t) return false;
              if (t !== editing.content) chat.edit(editing.id, t);
              setEditing(null);
              if (stash.current) window.setTimeout(() => seedText(stash.current), 0);
              return true;
            }
            const ok = chat.send(text, reply?.id ?? null, photos);
            if (ok) setReply(null);
            return ok;
          }}
          onTyping={chat.notifyTyping}
          disabled={!chat.connected}
        />
      )}

      {menu && (
        <MessageMenu
          x={menu.x}
          y={menu.y}
          row={menu.row}
          lift={menu.lift}
          del={{
            mine: menu.m.user === me && !menu.m.sys,
            run: (scope) => {
              chat.remove([menu.m.id], scope);
              setSelected(null);
            },
          }}
          readsOf={menu.m.sys ? undefined : { room: channel.room, id: menu.m.id }}
          items={menuItems(menu.m, menu.photo)}
          react={
            menu.m.sys
              ? undefined
              : {
                  mine: (menu.m.reactions ?? []).filter((r) => r.users.includes(me)).map((r) => r.e),
                  pick: (e) => chat.react(menu.m.id, e),
                }
          }
          onClose={() => setMenu(null)}
        />
      )}

      {del && (
        <Modal title={del.length > 1 ? t('Удалить {0}?', { 0: msgs(del.length) }) : t('Удалить сообщение?')} onClose={() => setDel(null)}>
          <p className="chat-modal-text">
            {delMine
              ? t('Можно убрать только у себя или удалить у всех участников чата.')
              : t('Чужие сообщения можно убрать только у себя, у остальных они останутся.')}
          </p>
          <div className="chat-modal-actions">
            {delMine && (
              <button className="btn btn-danger" onClick={() => doDelete('all')}>
                {t('Удалить у всех')}
              </button>
            )}
            <button className={'btn ' + (delMine ? 'btn-ghost' : 'btn-danger')} onClick={() => doDelete('me')}>
              {t('Удалить у меня')}
            </button>
            <button className="btn btn-ghost" onClick={() => setDel(null)}>
              {t('Отмена')}
            </button>
          </div>
        </Modal>
      )}

      {fwd && (
        <Modal title={t('Переслать {0}', { 0: msgs(fwd.length) })} onClose={() => setFwd(null)}>
          <div className="fwd-list">
            {targets.map((x) => (
              <button key={x.room} className="fwd-item" onClick={() => doForward(x)}>
                <span className="fwd-srv" style={{ background: x.server.gradient }}>
                  {x.server.short}
                </span>
                <span className="fwd-text">
                  <b>
                    <Icon name={x.icon} size={16} /> {x.label}
                  </b>
                  <span>{x.server.name}</span>
                </span>
                {x.room === channel.room && <span className="fwd-here">{t('этот чат')}</span>}
              </button>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}
