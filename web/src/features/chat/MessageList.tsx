import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../../shared/icons';
import { handleOf, type Attachment, type ChatMessage } from '../../shared/model';
import { Avatar } from '../../shared/ui/Avatar';
import { Nick } from '../members/Nick';
import { userMenuProps } from '../members/userMenu';
import { openProfile } from '../profile/profile';
import { LONG_PRESS_MS, mentionsMe, withMentions } from './mentions';
import { PhotoGrid, PhotoViewer, photosWidth } from './Photos';

const timeFmt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });

/** Время оригинала пересланного сообщения: в тот же день — только часы, иначе с датой. */
function fwdTime(orig: Date, msg: Date) {
  const t = timeFmt.format(orig);
  return orig.toDateString() === msg.toDateString() ? t : `${dayFmt.format(orig)}, ${t}`;
}

function dayLabel(d: Date) {
  const today = new Date();
  const y = new Date();
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Сегодня';
  if (d.toDateString() === y.toDateString()) return 'Вчера';
  return dayFmt.format(d);
}

/** Действия с сообщением из ленты (меню по ПКМ / долгому нажатию, выделение, переход к оригиналу ответа). */
export interface MessageActions {
  onMenu?: (m: ChatMessage, x: number, y: number) => void;
  /** Режим выделения: нажатие отмечает сообщение. */
  selecting?: boolean;
  selected?: Set<string>;
  onToggle?: (m: ChatMessage) => void;
  /** Нажали на цитату ответа — перейти к оригиналу. */
  onJump?: (id: number | string) => void;
  /** Подсветить и прокрутить к сообщению: меняется n — переход повторяется. */
  focus?: { id: number | string; n: number } | null;
  /** Сообщает, какой закреп показать в плашке (id; 0 — среди загруженных подходящего нет). */
  onView?: (pinId: number) => void;
  /** Свои сообщения с id ≤ этого прочитаны кем-то из собеседников (две галочки). */
  readUpTo?: number;
  /** Линия «Новое» — перед первым чужим сообщением с id больше этого (что было прочитано при открытии чата). */
  newAfter?: number;
}

type ListProps = { messages: ChatMessage[]; me: string; empty: ReactNode } & MessageActions;

/** Лента перерисовывается только когда меняется то, что в ней видно (сообщения, выделение, прочтения…).
 *  Раньше любое обновление приложения — кто-то заговорил в войсе, печатает, сменился онлайн — заново строило
 *  все сообщения с упоминаниями, фото и цитатами; на телефоне это и давало подвисания.
 *  Обработчики (они новые на каждой отрисовке ChatBody) подменяем постоянными, которые зовут свежие. */
export function MessageList(props: ListProps) {
  const latest = useRef(props);
  latest.current = props;
  const stable = useMemo(
    () => ({
      onMenu: (m: ChatMessage, x: number, y: number) => latest.current.onMenu?.(m, x, y),
      onToggle: (m: ChatMessage) => latest.current.onToggle?.(m),
      onJump: (id: number | string) => latest.current.onJump?.(id),
      onView: (id: number) => latest.current.onView?.(id),
    }),
    [],
  );
  return (
    <MessageListView
      {...props}
      onMenu={props.onMenu && stable.onMenu}
      onToggle={props.onToggle && stable.onToggle}
      onJump={props.onJump && stable.onJump}
      onView={props.onView && stable.onView}
    />
  );
}

const MessageListView = memo(MessageListImpl, (a, b) => {
  for (const k of Object.keys({ ...a, ...b }) as (keyof ListProps)[]) {
    // «пусто» — разметка, новая на каждой отрисовке; важна, только когда сообщений нет
    if (k === 'empty') {
      if (b.messages.length === 0) return false;
      continue;
    }
    if (a[k] !== b[k]) return false;
  }
  return true;
});

function MessageListImpl({
  messages,
  me,
  empty,
  onMenu,
  selecting,
  selected,
  onToggle,
  onJump,
  focus,
  readUpTo = 0,
  newAfter = 0,
  onView,
}: ListProps) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // «Запас» сверху ленты: в самом начале истории можно долистать дальше — первое сообщение
  // останавливается ближе к середине экрана. Появляется, только когда лента не помещается в экран.
  const head = useRef<HTMLDivElement>(null);
  const rest = (el: HTMLElement) => Math.max(0, el.scrollHeight - el.clientHeight);
  // Градиент своих сообщений — один на всё окно чата: каждому облачку сообщаем, где оно в окне (--by, --bh),
  // а окну — его высоту (--vh). Раньше это делал background-attachment: fixed, но пока экран выезжал (transform),
  // fixed переставал работать и градиент на миг становился у каждого облачка своим — мигал.
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
  /** Градиент своих облачков и их хвостиков — по положению в окне чата (сразу, до отрисовки кадра). */
  const paintNow = (all = false) => {
    const el = ref.current;
    if (!el) return;
    // Сначала все замеры, потом все записи: чередование «замер → запись» на каждом облачке заставляло
    // браузер пересчитывать раскладку столько раз, сколько своих сообщений, на каждом кадре прокрутки.
    const box = el.getBoundingClientRect();
    const h = el.clientHeight;
    const bubbles = el.querySelectorAll<HTMLElement>('.msg.mine .bubble');
    const rects = Array.from(bubbles, (b) => b.getBoundingClientRect());
    if (el.style.getPropertyValue('--vh') !== h + 'px') el.style.setProperty('--vh', h + 'px');
    const margin = h; // при прокрутке — только видимые и ближайшие; дальние получат значения, когда подъедут
    bubbles.forEach((b, i) => {
      const r = rects[i];
      const y = Math.round(r.top - box.top);
      // у всех облачков при первой раскладке: без значений хвостик оставался пустым
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
    const h = overflow ? Math.round(el.clientHeight * 0.4) : 0;
    if (h === cur) return;
    // высота запаса меняется — сохраняем то, что сейчас на экране (если не прилипли к низу)
    t.style.height = h + 'px';
    if (!stick.current) el.scrollTop += h - cur;
  };
  const press = useRef<{ t: number; x: number; y: number } | null>(null);
  /** Открытое на весь экран фото. */
  const [viewer, setViewer] = useState<{ photos: Attachment[]; i: number } | null>(null);
  // Кнопка «вниз»: появляется, когда ушли от низа ленты; на ней — сколько новых сообщений пришло, пока смотрели выше
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
    el.scrollTo({ top: rest(el), behavior: 'smooth' });
  };

  // «Линия чтения»: обычно сразу под плашкой закрепа, но к концам ленты нелинейно уходит к краям —
  // в самом верху выбирается первый закреп, в самом низу последний.
  const onViewRef = useRef(onView);
  onViewRef.current = onView;
  const raf = useRef(0);
  const report = () => {
    if (!onViewRef.current || raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      const el = ref.current;
      if (!el || !onViewRef.current) return;
      const box = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const top = box.top + parseFloat(cs.paddingTop || '0');
      const bottom = box.bottom - parseFloat(cs.paddingBottom || '0');
      // Линия — по нижнему краю плашки и ниже не опускается; только на последнем экране прокрутки
      // она плавно уходит к краю ленты (вверху — к верхнему, внизу — к нижнему)
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
      // Самый верхний закреп, который ещё виден ниже линии; если на экране закрепов нет —
      // последний, ушедший выше линии
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

  useLayoutEffect(() => {
    const el = ref.current;
    // удалённое сообщение схлопывается от своей настоящей высоты (см. @keyframes msg-out)
    el?.querySelectorAll<HTMLElement>('.msg-out:not([style*="--h"])').forEach((n) => n.style.setProperty('--h', `${n.offsetHeight}px`));
    // новые чужие сообщения, пришедшие, пока лента прокручена вверх, — в счётчик на кнопке «вниз»
    const last = messages.length ? Number(messages[messages.length - 1].id) || 0 : 0;
    if (!stick.current && lastSeen.current && last > lastSeen.current) {
      const fresh = messages.filter((m) => Number(m.id) > lastSeen.current && m.user !== me && !m.sys).length;
      if (fresh) setUnread((n) => n + fresh);
    }
    lastSeen.current = Math.max(lastSeen.current, last);
    if (el) sizeHead(el);
    if (el && stick.current) el.scrollTop = rest(el);
    report();
    paintGrad(true);
  }, [messages]); // eslint-disable-line react-hooks/exhaustive-deps
  // Высота поля ввода (--composer-h) приходит после первой отрисовки и меняет отступ снизу —
  // без этого последние сообщения оставались под полем ввода, лента «начиналась не снизу».
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
      // Пока плавно появляется/уходит виджет звонка, отступ ленты меняется на каждом кадре — тогда только
      // держим низ (дёшево), а полный пересчёт (замеры всех облачков) — один раз, когда отступ встанет
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
    // новые сообщения/картинки меняют высоту содержимого, а не самой ленты
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

  // Переход к сообщению: прокрутка к середине и короткая подсветка
  useEffect(() => {
    // старый переход (например, при открытии списка закреплённых лента создаётся заново) не повторяем
    if (!focus || Date.now() - focus.n > 1500) return;
    const row = ref.current?.querySelector<HTMLElement>(`[data-mid="${CSS.escape(String(focus.id))}"]`);
    if (!row) return;
    stick.current = false;
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    row.classList.remove('flash');
    void row.offsetWidth;
    row.classList.add('flash');
    const id = window.setTimeout(() => row.classList.remove('flash'), 1400);
    return () => window.clearTimeout(id);
  }, [focus]);

  const cancelPress = () => {
    if (press.current) window.clearTimeout(press.current.t);
    press.current = null;
  };

  const myTag = handleOf(me);
  // Первое фото сообщений ленты — миниатюра в цитате, если сервер не прислал её сам (старые ответы)
  const firstPhoto = new Map<string, string>();
  messages.forEach((x) => x.attachments?.[0] && firstPhoto.set(String(x.id), x.attachments[0].url));
  const items: ReactNode[] = [];
  let lastDay = '';
  let newPlaced = false;
  /** ПКМ и долгое нажатие на сообщение — меню. */
  const pressProps = (m: ChatMessage) => ({
    onContextMenu: (e: React.MouseEvent) => {
      if (!onMenu) return;
      e.preventDefault();
      cancelPress();
      if (!selecting) onMenu(m, e.clientX, e.clientY);
    },
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType !== 'touch' || selecting || !onMenu) return;
      const x = e.clientX;
      const y = e.clientY;
      press.current = {
        x,
        y,
        t: window.setTimeout(() => {
          press.current = null;
          navigator.vibrate?.(10);
          onMenu(m, x, y);
        }, LONG_PRESS_MS),
      };
    },
    onPointerMove: (e: React.PointerEvent) => {
      const p = press.current;
      if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 8) cancelPress();
    },
    onPointerUp: cancelPress,
    onPointerCancel: cancelPress,
  });
  messages.forEach((m) => {
    const d = m.ts ? new Date(m.ts) : new Date();
    const day = d.toDateString();
    if (day !== lastDay) {
      lastDay = day;
      items.push(
        <div className="date-pill" key={'d' + day}>
          {dayLabel(d)}
        </div>,
      );
    }
    if (newAfter > 0 && !newPlaced && !m.sys && m.user !== me && Number(m.id) > newAfter) {
      newPlaced = true;
      items.push(
        <div className="new-line" key="new-line" role="separator" aria-label="Новые сообщения">
          <span>Новое</span>
        </div>,
      );
    }
    const reply = m.reply;
    const replyPhoto = reply && !reply.deleted ? reply.photo || firstPhoto.get(String(reply.id)) : undefined;
    // Служебная строка «X закрепил(а) / открепил(а) …» — в стиле плашки даты, клик ведёт к сообщению.
    // Как и обычное сообщение: меню по ПКМ/долгому нажатию, выделение, удаление
    if (m.sys === 'pin' || m.sys === 'unpin') {
      const gone = !reply || reply.deleted;
      const sel = !!selected?.has(String(m.id));
      items.push(
        // Одна плашка по центру ленты: ник, действие и текст закреплённого сообщения
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
              {m.sys === 'pin' ? 'закрепил(а)' : 'открепил(а)'} {gone ? 'сообщение' : <>«{reply.content}»</>}
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
      <span className="msg-replies" title={`Ответов: ${m.replies}`}>
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
        {!mine && (
          <span className="msg-ava" {...userMenuProps(m.user)} onClick={(e) => (e.stopPropagation(), !selecting && openProfile(m.user))}>
            <Avatar name={m.user} size={34} />
          </span>
        )}
        <div
          className={'bubble' + (m.attachments?.length ? ' has-photos' : '')}
          // облачко с фото — по ширине фото (+ отступ 4px и рамка 1px с каждой стороны)
          style={m.attachments?.length ? { width: photosWidth(m.attachments) + 10 } : undefined}
        >
          {/* Шапка: имя · пин · время · ответы; у своих — наоборот, без имени и с галочками в конце */}
          <div className="meta">
            {!mine && (
              <span className="msg-nick" role="button" tabIndex={0} {...userMenuProps(m.user)} onClick={(e) => (e.stopPropagation(), !selecting && openProfile(m.user))}>
                <Nick name={m.user} />
              </span>
            )}
            {mine && replyCount}
            {!mine && pinMark}
            <time title={m.edited ? 'Изменено' : undefined}>
              {m.edited && <span className="msg-edited">изм. </span>}
              {timeFmt.format(d)}
            </time>
            {mine && pinMark}
            {!mine && replyCount}
            {mine && (
              <span className={'msg-ticks' + (read ? ' read' : '')} title={read ? 'Прочитано' : 'Отправлено'}>
                <Icon name={read ? 'check-double' : 'check'} size={15} />
              </span>
            )}
          </div>
          {m.fwd && (
            <div className="msg-fwd">
              <div className="fwd-title">
                <Icon name="reply" size={14} className="flip" />
                <span>Переслано от</span>
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
                <span className="rt">Сообщение удалено</span>
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
          {!!m.attachments?.length && (
            <PhotoGrid photos={m.attachments} onOpen={selecting ? undefined : (i) => setViewer({ photos: m.attachments!, i })} />
          )}
          {!!m.content && <div className="text">{withMentions(m.content, myTag)}</div>}
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
        stick.current = gap < 80;
        setAway(gap > 240);
        if (stick.current) setUnread(0);
        cancelPress();
        report();
        paintGrad(true);
      }}
    >
      <div className="chat-head-room" ref={head} aria-hidden />
      {messages.length ? items : <div className="empty-state">{empty}</div>}
      {viewer && <PhotoViewer photos={viewer.photos} start={viewer.i} onClose={() => setViewer(null)} />}
      {dock &&
        createPortal(
          <button
            type="button"
            className={'to-bottom glass' + (away || unread ? ' on' : '')}
            aria-label={unread ? `Новых сообщений: ${unread}. Прокрутить вниз` : 'Прокрутить вниз'}
            title="Вниз"
            tabIndex={away || unread ? 0 : -1}
            onClick={toBottom}
          >
            <Icon name="chevron-down" size={22} />
            {unread > 0 && <span className="tb-count">{unread > 99 ? '99+' : unread}</span>}
          </button>,
          dock,
        )}
    </div>
  );
}
