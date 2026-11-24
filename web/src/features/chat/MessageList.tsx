import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { haptic } from '../../shared/haptic';
import { Icon } from '../../shared/icons';
import { firstPhotoUrl, handleOf, type Attachment, type ChatMessage } from '../../shared/model';
import { Avatar } from '../../shared/ui/Avatar';
import { Nick } from '../members/Nick';
import { userMenuProps } from '../members/userMenu';
import { openProfile } from '../profile/profile';
import { LinkPreview } from './LinkPreview';
import { firstLink, LONG_PRESS_MS, mentionsMe, withMentions } from './mentions';
import { FileList, PhotoGrid, PhotoViewer, photosWidth } from './Photos';
import { dateFormat, lang, t } from '../../shared/i18n';

const timeFmt = dateFormat({ hour: '2-digit', minute: '2-digit' });
const dayFmt = dateFormat({ day: 'numeric', month: 'long' });

function fwdTime(orig: Date, msg: Date) {
  const t = timeFmt.format(orig);
  return orig.toDateString() === msg.toDateString() ? t : `${dayFmt.format(orig)}, ${t}`;
}

function dayLabel(d: Date) {
  const today = new Date();
  const y = new Date();
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return t('Сегодня');
  if (d.toDateString() === y.toDateString()) return t('Вчера');
  return dayFmt.format(d);
}

export interface MessageActions {
  onMenu?: (m: ChatMessage, x: number, y: number, row?: HTMLElement, lift?: boolean) => void;
  onReply?: (m: ChatMessage) => void;
  onReact?: (m: ChatMessage, emoji: string) => void;
  selecting?: boolean;
  selected?: Set<string>;
  onToggle?: (m: ChatMessage) => void;
  onJump?: (id: number | string) => void;
  focus?: { id: number | string; n: number } | null;
  onView?: (pinId: number) => void;
  /** The newest message that has been on screen: the read mark follows it, not the newest loaded one. */
  onSeen?: (id: number) => void;
  readUpTo?: number;
  newAfter?: number;
  more?: boolean;
  loadingOlder?: boolean;
  onOlder?: () => void;
}

// lang is passed only so the memoized list re-renders on a language switch
type ListProps = { messages: ChatMessage[]; me: string; empty: ReactNode; room?: string; lang?: string } & MessageActions;

/**
 * Messages rendered at once and added per step when scrolled to the top. The rest of loaded history stays
 * in memory: a long list in the DOM made scrolling and loading stutter on phones.
 */
const WINDOW = 60;
const STEP = 40;
/** Never keep more rows than this in the DOM; rows far from the viewport go back to memory. */
const MAX_ROWS = 140;
const SKELETON_ROWS = ['58%', '42%', '66%', '36%', '52%', '62%', '40%', '48%'];

/**
 * The list re-renders only when what it shows changes. Previously any app update (someone speaking, typing,
 * presence) rebuilt every message and caused stalls on phones. Handlers, new on each ChatBody render,
 * are replaced with stable ones that call the latest version.
 */
export function MessageList(props: ListProps) {
  const latest = useRef(props);
  latest.current = props;
  const stable = useMemo(
    () => ({
      onMenu: (m: ChatMessage, x: number, y: number, row?: HTMLElement, lift?: boolean) => latest.current.onMenu?.(m, x, y, row, lift),
      onReply: (m: ChatMessage) => latest.current.onReply?.(m),
      onReact: (m: ChatMessage, e: string) => latest.current.onReact?.(m, e),
      onToggle: (m: ChatMessage) => latest.current.onToggle?.(m),
      onJump: (id: number | string) => latest.current.onJump?.(id),
      onView: (id: number) => latest.current.onView?.(id),
      onOlder: () => latest.current.onOlder?.(),
      onSeen: (id: number) => latest.current.onSeen?.(id),
    }),
    [],
  );
  return (
    <MessageListView
      {...props}
      onMenu={props.onMenu && stable.onMenu}
      onReply={props.onReply && stable.onReply}
      onReact={props.onReact && stable.onReact}
      onToggle={props.onToggle && stable.onToggle}
      onJump={props.onJump && stable.onJump}
      onView={props.onView && stable.onView}
      onOlder={props.onOlder && stable.onOlder}
      onSeen={props.onSeen && stable.onSeen}
      lang={lang}
    />
  );
}

const MessageListView = memo(MessageListImpl, (a, b) => {
  for (const k of Object.keys({ ...a, ...b }) as (keyof ListProps)[]) {
    if (k === 'empty') {
      if (b.messages.length === 0) return false;
      continue;
    }
    if (a[k] !== b[k]) return false;
  }
  return true;
});

function MessageListImpl({
  messages: all,
  room = '',
  me,
  empty,
  onMenu,
  onReply,
  onReact,
  selecting,
  selected,
  onToggle,
  onJump,
  focus,
  readUpTo = 0,
  newAfter = 0,
  onView,
  onSeen,
  lang: shownLang,
  more,
  loadingOlder,
  onOlder,
}: ListProps) {
  const ref = useRef<HTMLDivElement>(null);
  // Rendered window of loaded history, from id floor to id ceil (null: up to the newest).
  // Every insertion into a long list made the browser restyle the whole page and scrolling stuttered on phones.
  // Ids instead of indexes, so messages loaded above or arriving below do not shift the window.
  const [win, setWin] = useState<{ room: string; floor: number; ceil: number | null } | null>(null);
  const cur = win && win.room === room ? win : null;
  const [firstIdx, endIdx] = useMemo(() => {
    const n = all.length;
    if (!cur) return [Math.max(0, n - WINDOW), n];
    let a = all.findIndex((m) => Number(m.id) >= cur.floor);
    if (a < 0) a = Math.max(0, n - WINDOW);
    let b = n;
    if (cur.ceil !== null) {
      const c = cur.ceil;
      const j = all.findIndex((m) => Number(m.id) > c);
      if (j >= 0) b = j;
    }
    if (b <= a) b = Math.min(n, a + WINDOW);
    return [a, b];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, cur?.floor, cur?.ceil]);
  const messages = useMemo(() => (firstIdx === 0 && endIdx === all.length ? all : all.slice(firstIdx, endIdx)), [all, firstIdx, endIdx]);
  const hidden = firstIdx;
  const below = all.length - endIdx;
  const winRef = useRef({ all, firstIdx, endIdx });
  winRef.current = { all, firstIdx, endIdx };
  const idAt = (list: ChatMessage[], i: number) => Number(list[i]?.id) || 0;
  const setRange = (a: number, b: number) => {
    const list = winRef.current.all;
    setWin({ room, floor: idAt(list, a), ceil: b >= list.length ? null : idAt(list, b - 1) });
  };
  // Unread messages older than the default window: start the window a little above the first of them.
  const firstNew = newAfter > 0 ? all.findIndex((m) => !m.sys && m.user !== me && Number(m.id) > newAfter) : -1;
  useEffect(() => {
    if (cur || !all.length) return;
    const from = firstNew >= 0 && firstNew < all.length - WINDOW ? Math.max(0, firstNew - 10) : Math.max(0, all.length - WINDOW);
    setWin({ room, floor: idAt(all, from), ceil: from + MAX_ROWS < all.length ? idAt(all, from + MAX_ROWS - 1) : null });
  }, [all, cur, room]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Room whose first screen is placed: with unread messages it opens at the "New" divider, not at the end. */
  const placed = useRef<string | null>(null);
  /** The row at the top of the viewport and its offset: after the window changes it is put back in place. */
  const anchor = useRef<{ id: string; top: number } | null>(null);
  const keepAnchor = () => {
    const el = ref.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    for (const row of el.querySelectorAll<HTMLElement>(':scope > [data-mid]')) {
      const r = row.getBoundingClientRect();
      if (r.bottom > box.top) {
        anchor.current = { id: row.dataset.mid!, top: r.top - box.top };
        return;
      }
    }
  };
  const reveal = () => {
    const { firstIdx: a, endIdx: b } = winRef.current;
    if (a <= 0) return false;
    keepAnchor();
    const na = Math.max(0, a - STEP);
    setRange(na, Math.min(b, na + MAX_ROWS));
    return true;
  };
  const revealDown = () => {
    const { all: list, firstIdx: a, endIdx: b } = winRef.current;
    if (b >= list.length) return false;
    keepAnchor();
    const nb = Math.min(list.length, b + STEP);
    setRange(Math.max(a, nb - MAX_ROWS), nb);
    return true;
  };
  /** Back at the bottom: trim the top of the DOM again after a pause so scrolling does not jump. */
  const trimTimer = useRef(0);
  const trimLater = () => {
    window.clearTimeout(trimTimer.current);
    trimTimer.current = window.setTimeout(() => {
      const { all: list, firstIdx: i, endIdx: e } = winRef.current;
      if (!stick.current || e < list.length || list.length - i <= WINDOW + STEP) return;
      setRange(list.length - WINDOW, list.length);
    }, 1500);
  };
  useEffect(() => () => window.clearTimeout(trimTimer.current), []);
  const stick = useRef(true);
  // Spacer above the list: at the very start of history you can scroll a bit further and the first message stops
  // closer to the middle of the screen. Only present when the list overflows the viewport.
  const head = useRef<HTMLDivElement>(null);
  const moreRef = useRef(more);
  moreRef.current = !!more || hidden > 0;
  /** First message and list height on the previous render: loading older messages keeps the viewport in place. */
  const prevTop = useRef<{ id: number; h: number } | null>(null);
  const rest = (el: HTMLElement) => Math.max(0, el.scrollHeight - el.clientHeight);
  // One own-message gradient for the whole chat window: each bubble gets its position (--by, --bh) and the window
  // its height (--vh). background-attachment: fixed used to do this, but it broke while the screen slid in
  // (transform) and every bubble flashed its own gradient.
  const gradRaf = useRef(0);
  const paintGrad = (now = false) => {
    if (now) {
      cancelAnimationFrame(gradRaf.current);
      gradRaf.current = 0;
      paintNow();
      return;
    }
    if (gradRaf.current) return;
    gradRaf.current = requestAnimationFrame(() => {
      gradRaf.current = 0;
      paintNow();
    });
  };
  const paintNow = (all = false) => {
    const el = ref.current;
    if (!el) return;
    // Measure everything first, then write: interleaving reads and writes forced a layout per own message
    // on every scroll frame.
    const box = el.getBoundingClientRect();
    const h = el.clientHeight;
    const bubbles = el.querySelectorAll<HTMLElement>('.msg.mine .bubble');
    const rects = Array.from(bubbles, (b) => b.getBoundingClientRect());
    if (el.style.getPropertyValue('--vh') !== h + 'px') el.style.setProperty('--vh', h + 'px');
    const margin = h; // While scrolling only visible and nearby bubbles are updated; the rest get values when they come close.
    bubbles.forEach((b, i) => {
      const r = rects[i];
      const y = Math.round(r.top - box.top);
      // All bubbles on the first layout, otherwise their tails stay empty.
      const has = b.style.getPropertyValue('--by') !== '';
      if (!all && has && (r.bottom < box.top - margin || r.top > box.bottom + margin)) return;
      const by = String(y);
      const bh = String(Math.round(r.height));
      if (b.style.getPropertyValue('--by') !== by) b.style.setProperty('--by', by);
      if (b.style.getPropertyValue('--bh') !== bh) b.style.setProperty('--bh', bh);
    });
  };
  useEffect(() => () => cancelAnimationFrame(gradRaf.current), []);
  const sizeHead = (el: HTMLElement) => {
    const t = head.current;
    if (!t) return;
    const cur = t.offsetHeight;
    const overflow = el.scrollHeight - cur > el.clientHeight + 1;
    const h = overflow && !moreRef.current ? Math.round(el.clientHeight * 0.4) : 0;
    if (h === cur) return;
    t.style.height = h + 'px';
    if (!stick.current) el.scrollTop += h - cur;
  };
  const press = useRef<{ t: number; x: number; y: number; hold: number; row: HTMLElement } | null>(null);
  const swipe = useRef<{ id: number; x: number; y: number; row: HTMLElement; m: ChatMessage; on: boolean; dx: number; ticked: boolean } | null>(null);
  // Safari hands the gesture to scrolling based on the first finger moves (and sends pointercancel), so the reply swipe
  // failed on slightly diagonal moves. While the finger moves more left than vertical, scrolling does not start.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let t0: { x: number; y: number; decided: boolean } | null = null;
    const start = (e: TouchEvent) => {
      const t = e.touches[0];
      t0 = e.touches.length === 1 && t ? { x: t.clientX, y: t.clientY, decided: false } : null;
    };
    const move = (e: TouchEvent) => {
      const sw = swipe.current;
      if (!sw || !t0 || e.touches.length !== 1) return;
      if (sw.on) return void (e.cancelable && e.preventDefault());
      if (t0.decided) return;
      const t = e.touches[0];
      const dx = t.clientX - t0.x;
      const dy = t.clientY - t0.y;
      if (Math.hypot(dx, dy) < 5) return;
      t0.decided = true;
      if (dx < 0 && Math.abs(dx) > Math.abs(dy) * 0.9 && e.cancelable) e.preventDefault();
    };
    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchmove', move, { passive: false });
    return () => {
      el.removeEventListener('touchstart', start);
      el.removeEventListener('touchmove', move);
    };
  }, []);
  const [viewer, setViewer] = useState<{ photos: Attachment[]; i: number } | null>(null);
  const [away, setAway] = useState(false);
  const [unread, setUnread] = useState(0);
  const [dock, setDock] = useState<HTMLElement | null>(null);
  const lastSeen = useRef<number>(0);
  useEffect(() => setDock(ref.current?.parentElement ?? null), []);
  const toBottom = () => {
    const el = ref.current;
    if (!el) return;
    stick.current = true;
    setUnread(0);
    // More messages below the window: jump straight to the newest instead of scrolling through history.
    const { all: list, endIdx: e } = winRef.current;
    if (e < list.length) {
      anchor.current = null;
      setRange(Math.max(0, list.length - WINDOW), list.length);
      return;
    }
    el.scrollTo({ top: rest(el), behavior: 'smooth' });
  };

  // The reading line normally sits right under the pinned banner but moves to the list edges near the ends,
  // so the first pin is chosen at the very top and the last one at the very bottom.
  const onViewRef = useRef(onView);
  onViewRef.current = onView;
  const onSeenRef = useRef(onSeen);
  onSeenRef.current = onSeen;
  /**
   * Floating date under the header (or the pinned banner): the day of the topmost visible message. It hides while
   * a real date divider sits at its spot, so the divider takes over and scrolls on with the feed.
   */
  const [dayFloat, setDayFloat] = useState<{ label: string; top: number } | null>(null);
  const floatDay = (el: HTMLElement, box: DOMRect, top: number) => {
    const dayOf = (row: HTMLElement) => {
      const m = winRef.current.all.find((x) => String(x.id) === row.dataset.mid);
      return m ? dayLabel(m.ts ? new Date(m.ts) : new Date()) : '';
    };
    let label = '';
    let passed = '';
    for (const row of el.querySelectorAll<HTMLElement>(':scope > [data-mid], :scope > .day-pill')) {
      const r = row.getBoundingClientRect();
      const pill = row.classList.contains('day-pill');
      if (r.bottom <= top) {
        if (!pill) passed = dayOf(row);
        continue;
      }
      // a divider at the floating spot replaces it; one lower down still leaves the previous day on top
      if (pill) label = r.top < top + r.height + 12 ? '' : passed;
      else label = dayOf(row);
      break;
    }
    const next = label && el.scrollTop > 8 ? { label, top: top - box.top + el.offsetTop + 6 } : null;
    setDayFloat((cur) => (cur?.label === next?.label && cur?.top === next?.top ? cur : next));
  };
  const raf = useRef(0);
  const report = () => {
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      const el = ref.current;
      if (!el) return;
      const box = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const top = box.top + parseFloat(cs.paddingTop || '0');
      floatDay(el, box, top);
      const bottom = box.bottom - parseFloat(cs.paddingBottom || '0');
      // not before the first screen is placed: it may flash at the end and would mark everything read
      if (onSeenRef.current && placed.current === room && box.height > 0) {
        // the lowest message whose first lines are in view; rows render oldest first
        const rows = el.querySelectorAll<HTMLElement>(':scope > [data-mid]');
        for (let i = rows.length - 1; i >= 0; i--) {
          const r = rows[i].getBoundingClientRect();
          const id = Number(rows[i].dataset.mid);
          if (r.top + Math.min(r.height, 40) > bottom || !Number.isFinite(id)) continue;
          if (r.bottom > top) onSeenRef.current(id);
          break;
        }
      }
      if (!onViewRef.current) return;
      const max = rest(el);
      const h = Math.max(bottom - top, 1);
      let limit = top;
      if (max <= 1) limit = bottom;
      else {
        const toEnd = max - el.scrollTop;
        const toStart = el.scrollTop;
        if (toEnd < h) limit = top + (bottom - top) * Math.pow(1 - toEnd / h, 3);
        else if (toStart < h) limit = top - (top - box.top) * Math.pow(1 - toStart / h, 3);
      }
      const pinned = el.querySelectorAll<HTMLElement>('[data-pin]');
      let visible = 0;
      let above = 0;
      for (const row of pinned) {
        const r = row.getBoundingClientRect();
        if (r.bottom <= limit) above = Number(row.dataset.mid) || 0;
        else {
          if (r.top < bottom) visible = Number(row.dataset.mid) || 0;
          break;
        }
      }
      onViewRef.current(visible || above);
    });
  };
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  // the floating day label holds text: read it again in the new language
  useEffect(() => report(), [shownLang]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const el = ref.current;
    // A deleted message collapses from its real height (see @keyframes msg-out).
    el?.querySelectorAll<HTMLElement>('.msg-out:not([style*="--h"])').forEach((n) => n.style.setProperty('--h', `${n.offsetHeight}px`));
    const last = all.length ? Number(all[all.length - 1].id) || 0 : 0;
    if (!stick.current && lastSeen.current && last > lastSeen.current) {
      const fresh = all.filter((m) => Number(m.id) > lastSeen.current && m.user !== me && !m.sys).length;
      if (fresh) setUnread((n) => n + fresh);
    }
    lastSeen.current = Math.max(lastSeen.current, last);
    const first = messages.length ? Number(messages[0].id) || 0 : 0;
    const was = prevTop.current;
    if (el) sizeHead(el);
    const an = anchor.current;
    anchor.current = null;
    const row = an && el && !stick.current ? el.querySelector<HTMLElement>(`:scope > [data-mid="${CSS.escape(an.id)}"]`) : null;
    if (el && row) {
      el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top - an!.top;
    } else if (el && was && first && first < was.id && !stick.current) el.scrollTop += el.scrollHeight - was.h;
    if (el && cur && placed.current !== room && messages.length) {
      placed.current = room;
      const line = el.querySelector<HTMLElement>(':scope > .new-line');
      if (line) {
        const top = el.getBoundingClientRect().top + parseFloat(getComputedStyle(el).paddingTop || '0');
        el.scrollTop = rest(el);
        const shift = line.getBoundingClientRect().top - top - 8;
        if (shift < 0) {
          el.scrollTop += shift;
          stick.current = false;
        }
      }
    }
    if (el && stick.current) el.scrollTop = rest(el);
    if (el) prevTop.current = { id: first, h: el.scrollHeight };
    report();
    paintGrad(true);
  }, [messages]); // eslint-disable-line react-hooks/exhaustive-deps
  // A history page arrived while the list is still at the top: show the next part right away.
  useEffect(() => {
    const el = ref.current;
    if (el && hidden > 0 && !stick.current && el.scrollTop < el.clientHeight * 1.5) reveal();
  }, [hidden > 0]); // eslint-disable-line react-hooks/exhaustive-deps
  // The composer height (--composer-h) arrives after the first render and changes the bottom padding;
  // without this the last messages stayed under the composer.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let settle = 0;
    const full = () => {
      sizeHead(el);
      if (stick.current) el.scrollTop = rest(el);
      report();
      paintGrad(true);
    };
    const pin = () => {
      // While the call widget animates, the padding changes every frame: only keep the bottom pinned (cheap)
      // and do the full re-measure once the padding settles.
      if (el.closest('.call-anim')) {
        if (stick.current) el.scrollTop = rest(el);
        window.clearTimeout(settle);
        settle = window.setTimeout(full, 120);
        return;
      }
      full();
    };
    const ro = new ResizeObserver(pin);
    ro.observe(el);
    Array.from(el.children).forEach((c) => ro.observe(c));
    const mo = new MutationObserver((list) => {
      list.forEach((m) => m.addedNodes.forEach((n) => n instanceof Element && ro.observe(n)));
      pin();
    });
    mo.observe(el, { childList: true });
    return () => {
      window.clearTimeout(settle);
      ro.disconnect();
      mo.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!focus || Date.now() - focus.n > 1500) return;
    // The message is loaded but outside the window: widen the window to it, the jump happens on the next render.
    const at = all.findIndex((m) => String(m.id) === String(focus.id));
    if (at >= 0 && (at < firstIdx || at >= endIdx)) {
      const a = Math.max(0, at - 20);
      setRange(a, Math.min(all.length, a + WINDOW + 20));
      return;
    }
    const row = ref.current?.querySelector<HTMLElement>(`[data-mid="${CSS.escape(String(focus.id))}"]`);
    if (!row) return;
    stick.current = false;
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    row.classList.remove('flash');
    void row.offsetWidth;
    row.classList.add('flash');
    const id = window.setTimeout(() => row.classList.remove('flash'), 1400);
    return () => window.clearTimeout(id);
  }, [focus, firstIdx, endIdx]); // eslint-disable-line react-hooks/exhaustive-deps

  const cancelPress = () => {
    const p = press.current;
    if (p) {
      window.clearTimeout(p.t);
      window.clearTimeout(p.hold);
      delete p.row.dataset.pressing;
    }
    press.current = null;
  };
  const SWIPE_REPLY = 56;
  const endSwipe = () => {
    const sw = swipe.current;
    swipe.current = null;
    if (!sw || !sw.on) return;
    const row = sw.row;
    row.style.transition = 'transform .26s cubic-bezier(.2, .8, .2, 1)';
    row.style.transform = '';
    row.style.removeProperty('--swp');
    window.setTimeout(() => {
      row.style.transition = '';
      delete row.dataset.swiping;
    }, 260);
    if (-sw.dx >= SWIPE_REPLY) onReply?.(sw.m);
  };

  const myTag = handleOf(me);
  // Thumbnail for reply quotes when the server did not send one (old replies).
  const firstPhoto = new Map<string, string>();
  all.forEach((x) => {
    const u = firstPhotoUrl(x.attachments);
    if (u) firstPhoto.set(String(x.id), u);
  });
  const items: ReactNode[] = [];
  let lastDay = '';
  let newPlaced = false;
  const pressProps = (m: ChatMessage) => ({
    onContextMenu: (e: React.MouseEvent) => {
      if (!onMenu) return;
      e.preventDefault();
      // On touch screens our own long press opens the menu (with the lifted message), the system one is not needed.
      if (matchMedia('(hover: none)').matches) return;
      cancelPress();
      if (!selecting) onMenu(m, e.clientX, e.clientY, e.currentTarget as HTMLElement, false);
    },
    onPointerDown: (e: React.PointerEvent) => {
      if (selecting) return;
      const mouse = e.pointerType === 'mouse';
      if (mouse && e.button !== 0) return;
      const row = e.currentTarget as HTMLElement;
      const x = e.clientX;
      const y = e.clientY;
      if (onReply && !m.sys && !m.leaving && !mouse) swipe.current = { id: e.pointerId, x, y, row, m, on: false, dx: 0, ticked: false };
      if (mouse || !onMenu) return;
      press.current = {
        x,
        y,
        row,
        hold: window.setTimeout(() => (row.dataset.pressing = ''), 140),
        t: window.setTimeout(() => {
          press.current = null;
          delete row.dataset.pressing;
          swipe.current = null;
          haptic();
          onMenu(m, x, y, row, true);
        }, LONG_PRESS_MS),
      };
    },
    onPointerMove: (e: React.PointerEvent) => {
      const p = press.current;
      if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 8) cancelPress();
      const sw = swipe.current;
      if (!sw || e.pointerId !== sw.id) return;
      const dx = e.clientX - sw.x;
      const dy = e.clientY - sw.y;
      if (!sw.on) {
        if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx) * 1.2) return void (swipe.current = null);
        if (dx > -10 || Math.abs(dx) <= Math.abs(dy) * 0.9) return;
        sw.on = true;
        sw.x = e.clientX;
        sw.row.dataset.swiping = '';
        window.getSelection()?.removeAllRanges();
        try {
          sw.row.setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      }
      const raw = Math.min(0, e.clientX - sw.x);
      const d = raw < -SWIPE_REPLY ? -SWIPE_REPLY - 20 * (1 - Math.exp((raw + SWIPE_REPLY) / 40)) : raw;
      sw.dx = raw;
      sw.row.style.transform = `translateX(${d}px)`;
      sw.row.style.setProperty('--swp', String(Math.min(1, -raw / SWIPE_REPLY)));
      if (!sw.ticked && -raw >= SWIPE_REPLY) {
        sw.ticked = true;
        haptic();
      } else if (sw.ticked && -raw < SWIPE_REPLY) sw.ticked = false;
    },
    onPointerUp: () => (cancelPress(), endSwipe()),
    onPointerCancel: () => (cancelPress(), endSwipe()),
  });
  messages.forEach((m) => {
    const d = m.ts ? new Date(m.ts) : new Date();
    const day = d.toDateString();
    if (day !== lastDay) {
      lastDay = day;
      items.push(
        <div className="date-pill day-pill" key={'d' + day}>
          {dayLabel(d)}
        </div>,
      );
    }
    if (newAfter > 0 && !newPlaced && !m.sys && m.user !== me && Number(m.id) > newAfter) {
      newPlaced = true;
      items.push(
        <div className="new-line" key="new-line" role="separator" aria-label={t('Новые сообщения')}>
          <span>{t('Новое')}</span>
        </div>,
      );
    }
    const reply = m.reply;
    const media = (m.attachments ?? []).filter((a) => !a.file);
    const docs = (m.attachments ?? []).filter((a) => a.file);
    const replyPhoto = reply && !reply.deleted ? reply.photo || firstPhoto.get(String(reply.id)) : undefined;
    if (m.sys === 'pin' || m.sys === 'unpin') {
      const gone = !reply || reply.deleted;
      const sel = !!selected?.has(String(m.id));
      items.push(
        <button
          type="button"
          className={'sys-row' + (gone ? ' gone' : '') + (m.leaving ? ' msg-out' : '') + (selecting ? ' selecting' : '') + (sel ? ' selected' : '')}
          key={m.id}
          data-mid={m.id}
          aria-disabled={(!selecting && gone) || undefined}
          onClick={() => {
            if (selecting) onToggle?.(m);
            else if (!gone) onJump?.(reply.id);
          }}
          {...pressProps(m)}
        >
          <span className="date-pill sys-note sn-one">
            <Icon name={m.sys === 'pin' ? 'pin-fill' : 'pin-off'} size={13} />
            <span className="sn-nick">
              <Nick name={m.user} />
            </span>
            <span className="sn-text">
              {m.sys === 'pin' ? t('закрепил(а)') : t('открепил(а)')} {gone ? t('сообщение') : <>«{reply.content}»</>}
            </span>
          </span>
        </button>,
      );
      return;
    }
    const mine = m.user === me;
    const isSel = !!selected?.has(String(m.id));
    const read = mine && Number(m.id) <= readUpTo;
    const pinMark = m.pinned ? <Icon name="pin-fill" size={15} className="msg-pin" /> : null;
    const replyCount = m.replies ? (
      <span className="msg-replies" title={t('Ответов: {0}', { 0: m.replies })}>
        <Icon name="reply-fill" size={14} />
        {m.replies}
      </span>
    ) : null;
    items.push(
      <div
        className={'msg' + (m.leaving ? ' msg-out' : '') + (mine ? ' mine' : '') + (selecting ? ' selecting' : '') + (isSel ? ' selected' : '') + (!mine && mentionsMe(m.content, myTag) ? ' mention-me' : '')}
        key={m.id}
        data-mid={m.id}
        data-pin={m.pinned ? '' : undefined}
        {...pressProps(m)}
        onClick={() => {
          if (selecting) onToggle?.(m);
        }}
      >
        {selecting && <span className={'msg-check' + (isSel ? ' on' : '')}>{isSel && <Icon name="check" size={14} />}</span>}
        {onReply && (
          <span className="msg-swipe-ico" aria-hidden="true">
            <Icon name="reply" size={20} />
          </span>
        )}
        {!mine && (
          <span className="msg-ava" {...userMenuProps(m.user)} onClick={(e) => (e.stopPropagation(), !selecting && openProfile(m.user, { inChat: true }))}>
            <Avatar name={m.user} size={34} />
          </span>
        )}
        <div
          className={'bubble' + (media.length ? ' has-photos' : '')}
          style={media.length ? { width: photosWidth(media) + 10 } : undefined}
        >
          <div className="meta">
            {!mine && (
              <span className="msg-nick" role="button" tabIndex={0} {...userMenuProps(m.user)} onClick={(e) => (e.stopPropagation(), !selecting && openProfile(m.user, { inChat: true }))}>
                <Nick name={m.user} />
              </span>
            )}
            {mine && replyCount}
            {!mine && pinMark}
            <time title={m.edited ? t('Изменено') : undefined}>
              {m.edited && <span className="msg-edited">{t('изм. ')}</span>}
              {timeFmt.format(d)}
            </time>
            {mine && pinMark}
            {!mine && replyCount}
            {mine && (
              <span className={'msg-ticks' + (read ? ' read' : '')} title={read ? t('Прочитано') : t('Отправлено')}>
                <Icon name={read ? 'check-double' : 'check'} size={15} />
              </span>
            )}
          </div>
          {m.fwd && (
            <div className="msg-fwd">
              <div className="fwd-title">
                <Icon name="reply" size={14} className="flip" />
                <span>{t('Переслано от')}</span>
              </div>
              <div className="fwd-from">
                <Avatar name={m.fwd.user} size={18} />
                <Nick name={m.fwd.user} />
                {m.fwd.ts && <time>{fwdTime(new Date(m.fwd.ts), d)}</time>}
              </div>
            </div>
          )}
          {reply && (
            <button
              type="button"
              className={'msg-reply' + (reply.deleted ? ' gone' : '') + (replyPhoto ? ' has-thumb' : '')}
              onClick={(e) => {
                e.stopPropagation();
                if (!selecting && !reply.deleted) onJump?.(reply.id);
              }}
            >
              {reply.deleted ? (
                <span className="rt">{t('Сообщение удалено')}</span>
              ) : replyPhoto ? (
                <>
                  <img className="rq-thumb" src={replyPhoto} alt="" loading="lazy" draggable={false} />
                  <span className="rq-body">
                    <Nick name={reply.user ?? ''} />
                    <span className="rt">{reply.content}</span>
                  </span>
                </>
              ) : (
                <>
                  <Nick name={reply.user ?? ''} />
                  <span className="rt">{reply.content}</span>
                </>
              )}
            </button>
          )}
          {!!media.length && <PhotoGrid photos={media} onOpen={selecting ? undefined : (i) => setViewer({ photos: media, i })} />}
          {!!docs.length && <FileList files={docs} selecting={!!selecting} />}
          {!!m.content && <div className="text">{withMentions(m.content, myTag)}</div>}
          {!!m.content && !m.attachments?.length && firstLink(m.content) && <LinkPreview url={firstLink(m.content)!} />}
          {!!m.reactions?.length && (
            <div className="reactions">
              {m.reactions.map((r) => (
                <button
                  key={r.e}
                  type="button"
                  className={'reaction' + (r.users.includes(me) ? ' on' : '')}
                  title={r.users.join(', ')}
                  disabled={!onReact}
                  onPointerDown={(e) => !selecting && e.stopPropagation()}
                  onClick={(e) => {
                    if (selecting) return;
                    e.stopPropagation();
                    onReact?.(m, r.e);
                  }}
                >
                  <span className="re-e">{r.e}</span>
                  <span className="re-n">{r.users.length}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>,
    );
  });

  return (
    <div
      className="chat-scroll"
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        const gap = rest(el) - el.scrollTop;
        stick.current = gap < 80 && below === 0;
        setAway(gap > 240 || below > 0);
        if (stick.current) {
          setUnread(0);
          if (all.length - hidden > WINDOW + STEP) trimLater();
        }
        // Near the top: reveal what is already loaded first, and ask the server early while memory still has a buffer.
        if (el.scrollTop < el.clientHeight * 2.5) reveal();
        else if (below > 0 && gap < el.clientHeight * 1.5) revealDown();
        if (more && hidden < STEP * 2) onOlder?.();
        if (prevTop.current) prevTop.current.h = el.scrollHeight;
        cancelPress();
        report();
        paintGrad(true);
      }}
    >
      <div className="chat-head-room" ref={head} aria-hidden />
      {(more || hidden > 0) && messages.length > 0 && (
        <div className="chat-older" aria-live="polite">
          {/* placeholder rows: a fast fling runs into them and slows down instead of stopping dead at the edge */}
          {SKELETON_ROWS.map((w, i) => (
            <span key={i} className={'skel skel-msg' + (i % 3 === 1 ? ' mine' : '')} style={{ width: w }} />
          ))}
          {loadingOlder && <span className="sr-only" role="status">{t('Загружаем более старые сообщения')}</span>}
        </div>
      )}
      {messages.length ? items : <div className="empty-state">{empty}</div>}
      {viewer && <PhotoViewer photos={viewer.photos} start={viewer.i} onClose={() => setViewer(null)} />}
      {dock &&
        createPortal(
          <button
            type="button"
            className={'to-bottom glass' + (away || unread ? ' on' : '')}
            aria-label={unread ? t('Новых сообщений: {0}. Прокрутить вниз', { 0: unread }) : t('Прокрутить вниз')}
            title={t('Вниз')}
            tabIndex={away || unread ? 0 : -1}
            onClick={toBottom}
          >
            <Icon name="chevron-down" size={22} />
            {unread > 0 && <span className="tb-count">{unread > 99 ? '99+' : unread}</span>}
          </button>,
          dock,
        )}
      {dock &&
        dayFloat &&
        createPortal(
          <div className="date-pill day-float" style={{ top: dayFloat.top }} aria-hidden>
            {dayFloat.label}
          </div>,
          dock,
        )}
    </div>
  );
}
