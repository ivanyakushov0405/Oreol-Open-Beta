import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Track } from 'livekit-client';
import { Icon, type IconName } from './icons';
import { avatarGradient, handleOf, initials, nameColor, type ChatMessage, type Status } from './mock';
import { useUser } from './auth';

/** Диаметр точки статуса из компонента Avatar в Figma: XS22/S28→8, M34→10, L38→11, XL48→13, 2XL80→22. */
function dotStyle(size: number): CSSProperties {
  if (size === 72) return { width: 19.5, height: 19.5, borderWidth: 3, right: 0, bottom: 0 };
  const d = size <= 28 ? 8 : size <= 34 ? 10 : size <= 38 ? 11 : size <= 48 ? 13 : Math.round(size * 0.275);
  return { width: d + 4, height: d + 4, borderWidth: 2, right: -2, bottom: -2 };
}

export function Avatar({
  name,
  size = 34,
  status,
  speaking,
}: {
  name: string;
  size?: number;
  status?: Status;
  speaking?: boolean;
}) {
  // Загруженный аватар из профиля; без него — инициалы на градиенте
  const img = useUser(name)?.avatar;
  return (
    <span
      className={'avatar' + (speaking ? ' speaking' : '') + (img ? ' has-img' : '')}
      style={{
        width: size,
        height: size,
        background: img ? `center / cover no-repeat url("${img}")` : avatarGradient(name),
        fontSize: Math.round(size * 0.38),
      }}
      aria-hidden="true"
    >
      {!img && initials(name)}
      {status && <i className={`status-dot status-${status}`} style={dotStyle(size)} />}
    </span>
  );
}

/** Фон профиля: загруженная картинка или фирменный градиент. */
export function Banner({ name, ...rest }: { name: string } & React.HTMLAttributes<HTMLDivElement>) {
  const img = useUser(name)?.banner;
  return <div className={'banner' + (img ? ' has-img' : '')} style={img ? { backgroundImage: `url("${img}")` } : undefined} {...rest} />;
}

/** Средний цвет картинки (по уменьшенной копии); null — пока не посчитан или картинки нет. */
const tintCache = new Map<string, string>();
export function useImageTint(url?: string | null) {
  const [tint, setTint] = useState<string | null>(() => (url ? tintCache.get(url) ?? null : null));
  useEffect(() => {
    if (!url) return setTint(null);
    const hit = tintCache.get(url);
    if (hit) return setTint(hit);
    let alive = true;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 16;
        const g = c.getContext('2d', { willReadFrequently: true });
        if (!g) return;
        // Средний цвет верхней части — она примыкает к заливке над фоном
        g.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight * 0.5, 0, 0, 16, 16);
        const d = g.getImageData(0, 0, 16, 16).data;
        let r = 0, gr = 0, b = 0;
        for (let i = 0; i < d.length; i += 4) { r += d[i]; gr += d[i + 1]; b += d[i + 2]; }
        const n = d.length / 4;
        const v = `rgb(${Math.round(r / n)}, ${Math.round(gr / n)}, ${Math.round(b / n)})`;
        tintCache.set(url, v);
        if (alive) setTint(v);
      } catch {
        /* чужой домен без CORS — останется градиент по умолчанию */
      }
    };
    img.src = url;
    return () => {
      alive = false;
    };
  }, [url]);
  return tint;
}

/** Заливка над фоном профиля (под строкой состояния и виджетом звонка):
 *  у своей картинки — градиент из её среднего цвета, у фона по умолчанию — тот же градиент бренда. */
export function BannerTop({ name }: { name: string }) {
  const img = useUser(name)?.banner;
  const tint = useImageTint(img);
  return (
    <div
      className="banner-top"
      style={tint ? { background: `linear-gradient(to bottom, color-mix(in srgb, ${tint} 62%, #000), ${tint})` } : undefined}
    />
  );
}

/** Отображаемое имя пользователя (или его юзернейм, если профиля нет). */
export function useDisplayName(name: string) {
  return useUser(name)?.displayName || name;
}

export function Nick({ name, children }: { name: string; children?: ReactNode }) {
  const display = useDisplayName(name);
  return (
    <b style={{ color: nameColor(name) }}>
      {display}
      {children}
    </b>
  );
}

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
}

const LONG_PRESS_MS = 420;

export function MessageList({
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
  onView,
}: { messages: ChatMessage[]; me: string; empty: ReactNode } & MessageActions) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const press = useRef<{ t: number; x: number; y: number } | null>(null);
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
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
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
      const max = el.scrollHeight - el.clientHeight;
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
    // новые чужие сообщения, пришедшие, пока лента прокручена вверх, — в счётчик на кнопке «вниз»
    const last = messages.length ? Number(messages[messages.length - 1].id) || 0 : 0;
    if (!stick.current && lastSeen.current && last > lastSeen.current) {
      const fresh = messages.filter((m) => Number(m.id) > lastSeen.current && m.user !== me && !m.sys).length;
      if (fresh) setUnread((n) => n + fresh);
    }
    lastSeen.current = Math.max(lastSeen.current, last);
    if (el && stick.current) el.scrollTop = el.scrollHeight;
    report();
  }, [messages]); // eslint-disable-line react-hooks/exhaustive-deps
  // Высота поля ввода (--composer-h) приходит после первой отрисовки и меняет отступ снизу —
  // без этого последние сообщения оставались под полем ввода, лента «начиналась не снизу».
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const pin = () => {
      if (stick.current) el.scrollTop = el.scrollHeight;
      report();
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

  const items: ReactNode[] = [];
  let lastDay = '';
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
    const reply = m.reply;
    // Служебная строка «X закрепил(а) / открепил(а) …» — в стиле плашки даты, клик ведёт к сообщению.
    // Как и обычное сообщение: меню по ПКМ/долгому нажатию, выделение, удаление
    if (m.sys === 'pin' || m.sys === 'unpin') {
      const gone = !reply || reply.deleted;
      const sel = !!selected?.has(String(m.id));
      items.push(
        // Одна плашка по центру ленты: ник, действие и текст закреплённого сообщения
        <button
          type="button"
          className={'sys-row' + (gone ? ' gone' : '') + (selecting ? ' selecting' : '') + (sel ? ' selected' : '')}
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
            <Icon name={m.sys === 'pin' ? 'pin-fill' : 'pin'} size={13} />
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
        className={'msg' + (mine ? ' mine' : '') + (selecting ? ' selecting' : '') + (isSel ? ' selected' : '')}
        key={m.id}
        data-mid={m.id}
        data-pin={m.pinned ? '' : undefined}
        {...pressProps(m)}
        onClick={() => {
          if (selecting) onToggle?.(m);
        }}
      >
        {selecting && <span className={'msg-check' + (isSel ? ' on' : '')}>{isSel && <Icon name="check" size={14} />}</span>}
        {!mine && <Avatar name={m.user} size={34} />}
        <div className="bubble">
          {/* Шапка: имя · пин · время · ответы; у своих — наоборот, без имени и с галочками в конце */}
          <div className="meta">
            {!mine && <Nick name={m.user} />}
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
              className={'msg-reply' + (reply.deleted ? ' gone' : '')}
              onClick={(e) => {
                e.stopPropagation();
                if (!selecting && !reply.deleted) onJump?.(reply.id);
              }}
            >
              {reply.deleted ? (
                <span className="rt">Сообщение удалено</span>
              ) : (
                <>
                  <Nick name={reply.user ?? ''} />
                  <span className="rt">{reply.content}</span>
                </>
              )}
            </button>
          )}
          <div className="text">{m.content}</div>
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
        const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
        stick.current = gap < 80;
        setAway(gap > 240);
        if (stick.current) setUnread(0);
        cancelPress();
        report();
      }}
    >
      {messages.length ? items : <div className="empty-state">{empty}</div>}
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

export function Composer({
  placeholder,
  onSend,
  onTyping,
  disabled,
  bar,
  seed,
  onCancel,
  onDraft,
}: {
  placeholder: string;
  onSend: (text: string) => boolean;
  onTyping?: () => void;
  disabled?: boolean;
  /** Плашка над полем: «Ответ …» / «Редактирование». */
  bar?: ReactNode;
  /** Подставить текст и поставить курсор в поле (меняется key — срабатывает снова). */
  seed?: { key: number; text: string | null } | null;
  /** Esc в поле — отменить ответ/правку. */
  onCancel?: () => void;
  /** Текущий текст поля — чтобы черновик можно было вернуть после правки сообщения. */
  onDraft?: (text: string) => void;
}) {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    onDraft?.(text);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!seed) return;
    // null — текст не трогаем (ответ на сообщение не стирает черновик), только ставим курсор в поле
    if (seed.text !== null) setText(seed.text);
    const el = inputRef.current;
    if (el) {
      el.focus();
      requestAnimationFrame(() => el.setSelectionRange(el.value.length, el.value.length));
    }
  }, [seed?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const submit = () => {
    if (onSend(text)) setText('');
  };
  // Лента сообщений уходит под поле ввода до самого низа: сообщаем её контейнеру высоту поля
  const formRef = useRef<HTMLFormElement>(null);
  useLayoutEffect(() => {
    const el = formRef.current;
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
    <form
      ref={formRef}
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <button type="button" className="round" title="Вложения появятся с полноценным бэкендом" disabled>
        <Icon name="attach" />
      </button>
      <div className={'field' + (bar ? ' has-bar' : '')}>
        {bar}
        <input
          ref={inputRef}
          value={text}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && onCancel) {
              e.preventDefault();
              onCancel();
              setText('');
            }
          }}
          placeholder={placeholder}
          disabled={disabled}
          maxLength={2000}
          onChange={(e) => {
            setText(e.target.value);
            onTyping?.();
          }}
        />
        <button type="button" className="icon-btn" title="Эмодзи" onClick={() => setText((t) => t + '🙂')}>
          <Icon name="smile" />
        </button>
        <button type="submit" className={"send-btn" + (text.trim() ? " show" : "")} title="Отправить" disabled={disabled || !text.trim()} tabIndex={text.trim() ? 0 : -1}>
          <Icon name="send" size={18} />
        </button>
      </div>
    </form>
  );
}

export function DisplayName({ name }: { name: string }) {
  return <>{useDisplayName(name)}</>;
}

/** «Имя печатает…»: при нехватке места обрезается имя, а «печатает» и точки остаются видны. */
export function TypingLine({ users, fallback }: { users: string[]; fallback: ReactNode }) {
  if (!users.length) return <>{fallback}</>;
  const shown = users.slice(0, 2);
  return (
    <span className="typing-line">
      <span className="typing-who">
        {shown.map((u, i) => (
          <span key={u}>
            {i > 0 && ', '}
            <DisplayName name={u} />
          </span>
        ))}
      </span>
      <span className="typing-verb">{users.length === 1 ? 'печатает' : 'печатают'}</span>
      <span className="typing-dots">
        <i />
        <i />
        <i />
      </span>
    </span>
  );
}

export function MemberRow({
  name,
  me,
  sub,
  status = 'online',
  onClick,
}: {
  name: string;
  me?: boolean;
  sub: string;
  status?: Status;
  onClick?: (e: React.MouseEvent) => void;
}) {
  return (
    <button className={'member' + (status === 'offline' ? ' offline' : '')} onClick={onClick}>
      <Avatar name={name} size={34} status={status} />
      <span className="info">
        <Nick name={name}>{me && <span className="you-tag"> · вы</span>}</Nick>
        <span>{sub}</span>
      </span>
    </button>
  );
}

export function VideoView({ track, mirror, contain }: { track: Track; mirror?: boolean; contain?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);
  return <video ref={ref} autoPlay playsInline muted className={(mirror ? 'mirror ' : '') + (contain ? 'contain' : '')} />;
}

export function FlagIcons({
  micMuted,
  deafened,
  camera,
  screen,
  size = 16,
}: {
  micMuted?: boolean;
  deafened?: boolean;
  camera?: boolean;
  screen?: boolean;
  size?: number;
}) {
  // Порядок справа налево, как в макете: микрофон, наушники, видео.
  const list: { name: IconName; off?: boolean }[] = [];
  if (camera) list.push({ name: 'video' });
  if (screen) list.push({ name: 'screen-share' });
  if (deafened) list.push({ name: 'headphones-off', off: true });
  else if (micMuted) list.push({ name: 'mic-off', off: true });
  return (
    <>
      {list.map((i) => (
        <span key={i.name} className={i.off ? 'off' : undefined} style={{ display: 'inline-flex' }}>
          <Icon name={i.name} size={size} />
        </span>
      ))}
    </>
  );
}

export function Modal({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return <>{children}</>;
}

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
  const setExpanded = (v: boolean | ((x: boolean) => boolean)) => {
    setExpandedState((x) => {
      const next = typeof v === 'function' ? v(x) : v;
      if (next) setExtras(true);
      // запасной вариант, если transitionend не придёт (вкладка в фоне, прерванный жест)
      else window.setTimeout(() => !expRef.current && setExtras(false), 420);
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
      <div className="popover-backdrop" onClick={onClose} />
      <div
        className={'member-card' + (sheet ? ' sheet' : '') + (sheet && expanded ? ' expanded' : '') + (drag ? ' dragging' : '')}
        ref={ref}
        style={
          sheet
            ? {
                height: h0 === null ? undefined : expanded ? 'calc(100% - env(safe-area-inset-top) - 54px)' : h0,
                transform: drag > 0 ? `translateY(${drag}px)` : undefined,
              }
            : pos
        }
        onTransitionEnd={(e) => {
          if (sheet && e.propertyName === 'height' && !expanded) setExtras(false);
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
        <div className="body">
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
                  <div className="mc-over">Общие серверы — 1</div>
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
                    placeholder="Нажми, чтобы добавить заметку — её видишь только ты"
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
      </div>
    </Modal>
  );
}

export type ToastKind = 'info' | 'success' | 'error';

/** Всплывающее сообщение внизу экрана: info — нейтральное, success — зелёное, error — красное. */
export function useToast() {
  const [msg, setMsg] = useState<{ text: string; kind: ToastKind; id: number } | null>(null);
  useEffect(() => {
    if (!msg) return;
    const id = window.setTimeout(() => setMsg(null), 3200);
    return () => window.clearTimeout(id);
  }, [msg]);
  const show = useCallback((text: string | null, kind: ToastKind = 'info') => setMsg(text ? { text, kind, id: Date.now() } : null), []);
  return {
    toast: msg ? (
      <div key={msg.id} className={`toast toast-${msg.kind}`} role={msg.kind === 'error' ? 'alert' : 'status'}>
        {msg.kind !== 'info' && <Icon name={msg.kind === 'success' ? 'check' : 'alert'} />}
        <span>{msg.text}</span>
      </div>
    ) : null,
    show,
  };
}

/** Плашка сверху: нет связи с сервером / переподключение голоса. */
export function ConnBanner({ text, tone = 'warn' }: { text: string; tone?: 'warn' | 'error' }) {
  return (
    <div className={`conn-banner conn-${tone}`} role="status">
      <span className="conn-spin" />
      <span>{text}</span>
    </div>
  );
}
