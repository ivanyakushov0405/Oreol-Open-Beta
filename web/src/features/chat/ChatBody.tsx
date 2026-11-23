import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { paths } from '../../app/router';
import type { AppState } from '../../app/useAppState';
import { getToken } from '../../shared/api';
import { Icon, type IconName } from '../../shared/icons';
import { Avatar } from '../../shared/ui/Avatar';
import { previewText, type Channel, type ChatMessage } from '../../shared/model';
import { DisplayName } from '../members/Nick';
import { useOpenChat } from '../notifications/notifications';
import { Composer } from './Composer';
import { MessageList } from './MessageList';
import { copyPhoto, prefetchPhoto, savePhoto, touchDevice } from './Photos';

type Chat = AppState['general'];
type Id = number | string;

/** Кнопка «Закреплённые» для шапки чата: переключает ленту на закреплённые и обратно. */
export function PinnedButton({ chat, className = 'icon-btn' }: { chat: Chat; className?: string }) {
  const on = chat.view === 'pinned';
  return (
    <button
      className={className + (on ? ' active' : '')}
      title={on ? 'Вернуться к чату' : 'Закреплённые'}
      aria-label="Закреплённые"
      aria-pressed={on}
      onClick={() => chat.setView(on ? 'all' : 'pinned')}
    >
      <Icon name={on ? 'pin-fill' : 'pin'} />
      {chat.pinned.length > 0 && <span className="pin-count">{chat.pinned.length}</span>}
    </button>
  );
}

/* ---------- Меню сообщения (ПКМ / долгое нажатие) ---------- */
interface MenuItem {
  icon: IconName;
  label: string;
  danger?: boolean;
  flip?: boolean;
  /** Нижняя группа (изменить, удалить) — отделена чертой. */
  tail?: boolean;
  /** Не действие, а переход на страницу меню (подтверждение удаления). */
  page?: 'delete';
  run: () => void;
}
/** Подтверждение удаления прямо в меню: mine — своё (можно удалить у всех). */
interface DeleteAsk {
  mine: boolean;
  run: (scope: 'me' | 'all') => void;
}

const readTimeFmt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const readDayFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });
function readWhen(iso: string | null) {
  if (!iso) return '';
  const d = new Date(iso);
  const t = readTimeFmt.format(d);
  const today = new Date();
  const y = new Date();
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return `сегодня в ${t}`;
  if (d.toDateString() === y.toDateString()) return `вчера в ${t}`;
  return `${readDayFmt.format(d)} в ${t}`;
}

type Reads = { user: string; at: string | null }[] | null;
/** Кто и когда прочитал сообщение. */
function useReads(src?: { room: string; id: Id }) {
  const [reads, setReads] = useState<Reads>(null);
  const room = src?.room;
  const id = src?.id;
  useEffect(() => {
    if (!room || id == null) return;
    let alive = true;
    fetch(`/api/chat/${encodeURIComponent(room)}/reads/${encodeURIComponent(String(id))}`, { headers: { Authorization: `Bearer ${getToken() ?? ''}` } })
      .then((r) => (r.ok ? r.json() : { reads: [] }))
      .then((d) => alive && setReads(d.reads ?? []))
      .catch(() => alive && setReads([]));
    return () => {
      alive = false;
    };
  }, [room, id]);
  return reads;
}

/** Список прочитавших (вторая страница меню): имя, под ним — когда, справа — галочки. */
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
            <span className="mm-read-at">{r.at ? readWhen(r.at) : 'прочитано до записи времени'}</span>
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
  onClose,
}: {
  x: number;
  y: number;
  /** Строка сообщения: меню встаёт вплотную над ней или под ней, не закрывая её. */
  row?: HTMLElement;
  /** Телефон: открыто долгим нажатием — сообщение поднято над размытым экраном. */
  lift?: boolean;
  /** Сообщение, для которого показать «кто прочитал» (служебным строкам — не нужно). */
  readsOf?: { room: string; id: Id };
  del?: DeleteAsk;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const reads = useReads(readsOf);
  /** Страница меню: действия, список прочитавших или подтверждение удаления (переезжают внутри того же окна). */
  const [page, setPage] = useState<'main' | 'reads' | 'delete'>('main');
  /** Ширина меню на странице действий — другие страницы не уже неё (окно не «прыгает»). */
  const [width, setWidth] = useState<number | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number; maxH?: number; origin: string }>({ left: x, top: y, origin: 'top left' });
  const focus = !!lift && !!row;
  /** Палец, который держал сообщение, отпускают уже над меню — это отпускание ничего не нажимает. */
  const armed = useRef(!focus);
  // Меню не вылезает за экран и не закрывает сообщение: вплотную под ним, а если снизу мало места — над ним
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const pad = 8;
    const gap = 6;
    if (row) {
      const r = row.getBoundingClientRect();
      const bubble = (row.querySelector('.bubble, .sys-note') as HTMLElement | null)?.getBoundingClientRect() ?? r;
      const box = host.current;
      if (focus && box) {
        // копия сообщения поверх размытия — там же, где оригинал
        box.replaceChildren();
        const clone = row.cloneNode(true) as HTMLElement;
        clone.removeAttribute('data-pressing');
        clone.style.cssText = '';
        // строка — во всю ширину копии (служебная строка-кнопка иначе сжималась по содержимому и уезжала влево)
        clone.style.width = '100%';
        // классы ленты оставляем (от них зависят цвета облачка), а её собственную раскладку снимаем
        const scroll = document.createElement('div');
        scroll.className = 'chat-scroll';
        scroll.style.cssText = 'all: unset; display: block';
        // градиент своих сообщений считается по высоте ленты (--vh/--by/--bh): без них в копии закрашивалась
        // только верхняя полоска облачка
        const cs = getComputedStyle(row.querySelector('.bubble') ?? row);
        for (const v of ['--vh', '--by', '--bh']) {
          const val = cs.getPropertyValue(v);
          if (val) scroll.style.setProperty(v, val);
        }
        scroll.appendChild(clone);
        box.appendChild(scroll);
        box.style.left = `${r.left}px`;
        box.style.width = `${r.width}px`;
        box.style.top = `${r.top}px`;
        // оригинал под размытием прячем: копия — единственное сообщение на экране (раньше он просвечивал размытым краем)
        row.style.visibility = 'hidden';
      }
      const mine = row.classList.contains('mine');
      // по горизонтали — у края облачка (своё — справа); мышью — ближе к курсору, но в пределах облачка
      const want = focus ? (mine ? bubble.right - w : bubble.left) : Math.min(Math.max(x - 24, bubble.left), Math.max(bubble.left, bubble.right - w));
      const left = Math.max(pad, Math.min(want, innerWidth - w - pad));
      const spaceBelow = innerHeight - pad - (bubble.bottom + gap);
      const spaceAbove = bubble.top - gap - pad;
      const below = spaceBelow >= h || (spaceBelow >= spaceAbove && spaceBelow >= 160);
      const origin = `${below ? 'top' : 'bottom'} ${mine ? 'right' : 'left'}`;
      if (below) return setPos({ left, top: bubble.bottom + gap, maxH: spaceBelow, origin });
      // над сообщением меню держится нижним краем: страницы («кто прочитал», удаление) растут вверх, а не на сообщение
      if (spaceAbove >= h) return setPos({ left, bottom: innerHeight - bubble.top + gap, maxH: spaceAbove, origin });
      // высокое сообщение на низком экране (телефон набок, фото): сбоку от облачка, если там есть место
      const side = mine ? bubble.left - gap - w : bubble.right + gap;
      if (side >= pad && side + w <= innerWidth - pad) {
        const st = Math.max(pad, Math.min(bubble.top, innerHeight - h - pad));
        return setPos({ left: side, top: st, maxH: innerHeight - st - pad, origin: `top ${mine ? 'right' : 'left'}` });
      }
      if (spaceAbove >= Math.min(h, 160) || !focus) return setPos({ left, bottom: innerHeight - bubble.top + gap, maxH: Math.max(spaceAbove, 120), origin });
      // длинное сообщение на телефоне: меню прижато к низу экрана, сообщение — над ним насколько влезает
      const top = innerHeight - h - pad;
      if (box) box.style.top = `${Math.max(pad, Math.min(r.top, top - gap - r.height))}px`;
      setPos({ left, top, maxH: h, origin });
      return;
    }
    const up = y + h + pad > innerHeight;
    const left = Math.max(pad, Math.min(x, innerWidth - w - pad));
    const top = Math.max(pad, up ? y - h : y);
    setPos({ left, top, origin: `${up ? 'bottom' : 'top'} ${left < x - w / 2 ? 'right' : 'left'}` });
  }, [x, y, row, focus]);
  useEffect(() => (focus && row ? () => void row.style.removeProperty('visibility') : undefined), [row, focus]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  /** Размер окна до смены страницы — новая страница плавно дорастает от него, а не прыгает. */
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
    // окно у правого края облачка (своё сообщение) держит правый край на месте и не вылезает за экран
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
                  <span>{!reads ? 'Загружаем…' : reads.length ? `Прочитали: ${reads.length}` : 'Ещё никто не прочитал'}</span>
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
              <span>Удалить сообщение?</span>
            </button>
            <div className="msg-menu-sep" />
            <p className="mm-del-text">
              {del.mine ? 'Можно убрать только у себя или удалить у всех участников чата.' : 'Чужое сообщение можно убрать только у себя, у остальных оно останется.'}
            </p>
            {del.mine && (
              <button type="button" className="msg-menu-item danger" onClick={() => (onClose(), del.run('all'))}>
                <Icon name="users" size={18} />
                <span>Удалить у всех</span>
              </button>
            )}
            <button type="button" className="msg-menu-item danger" onClick={() => (onClose(), del.run('me'))}>
              <Icon name="user" size={18} />
              <span>Удалить у меня</span>
            </button>
            <div className="msg-menu-sep" />
            <button type="button" className="msg-menu-item" onClick={() => go('main')}>
              <Icon name="close" size={18} />
              <span>Отмена</span>
            </button>
          </div>
        ) : (
          <div className="mm-page mm-page-reads anim" key="reads">
            <button type="button" className="msg-menu-item mm-back" onClick={() => go('main')}>
              <Icon name="back" size={18} />
              <span>Прочитали: {reads?.length ?? 0}</span>
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

/* ---------- Модальные окна: удаление и пересылка ---------- */
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
          <button className="icon-btn" title="Закрыть" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

function plural(n: number, one: string, few: string, many: string) {
  const a = n % 10;
  const b = n % 100;
  if (a === 1 && b !== 11) return one;
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
  return many;
}
const msgs = (n: number) => `${n} ${plural(n, 'сообщение', 'сообщения', 'сообщений')}`;

/* ---------- Текстовый чат с действиями над сообщениями ---------- */
export function ChatBody({ app, chat, channel, compact }: { app: AppState; chat: Chat; channel: Channel; compact?: boolean }) {
  const cls = 'chat' + (app.glassChat ? ' transparent' : '');
  const title = channel.kind === 'voice' ? `чат «${channel.name}»` : `#${channel.name}`;
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

  // Сменился канал — сбрасываем всё, что относилось к прошлому
  useEffect(() => {
    setMenu(null);
    setReply(null);
    setEditing(null);
    setSelected(null);
    setDel(null);
    setFwd(null);
  }, [channel.room]);

  const byId = useMemo(() => new Map(chat.messages.map((m) => [String(m.id), m])), [chat.messages]);
  // Сообщение удалили (у всех или у себя) — убираем его из ответа/правки/выделения
  useEffect(() => {
    if (reply && !byId.has(String(reply.id))) setReply(null);
    if (editing && !byId.has(String(editing.id))) setEditing(null);
    if (selected) {
      const next = new Set([...selected].filter((id) => byId.has(id)));
      if (next.size !== selected.size) setSelected(next);
    }
  }, [byId]); // eslint-disable-line react-hooks/exhaustive-deps

  const seedText = (text: string | null) => setSeed({ key: Date.now(), text });
  /** Текст в поле сейчас и черновик, отложенный на время правки сообщения. */
  const draft = useRef('');
  const stash = useRef('');
  const startReply = (m: ChatMessage) => {
    // Из правки — возвращаем черновик; иначе написанное остаётся в поле
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
  // Clipboard API недоступен без фокуса/HTTPS — тогда копируем через скрытое поле
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
    const done = (ok: boolean) => app.notify(ok ? 'Скопировано' : 'Не удалось скопировать', ok ? 'success' : 'error');
    if (!navigator.clipboard) return done(copyLegacy(text));
    navigator.clipboard.writeText(text).then(
      () => done(true),
      () => done(copyLegacy(text)),
    );
  };
  const jump = (id: Id) => {
    if (!byId.has(String(id))) {
      app.notify('Сообщение слишком старое, его нет в загруженной истории');
      return;
    }
    if (pinnedView) chat.setView('all');
    setFocus({ id, n: Date.now() });
  };
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
    const saved = (res: 'ok' | 'cancel' | 'fail') => res === 'fail' && app.notify('Не удалось сохранить фото', 'error');
    // телефон: только «Сохранить» (системное «Поделиться» → «Сохранить изображение»)
    if (touchDevice()) return [{ icon: 'download', label: 'Сохранить фото', run: () => void savePhoto(url, false).then(saved) }];
    return [
      {
        icon: 'copy',
        label: 'Копировать изображение',
        run: () => void copyPhoto(url).then((ok) => app.notify(ok ? 'Изображение скопировано' : 'Не удалось скопировать', ok ? 'success' : 'error')),
      },
      { icon: 'download', label: 'Сохранить как…', run: () => void savePhoto(url, true).then(saved) },
    ];
  };
  const menuItems = (m: ChatMessage, photo?: string): MenuItem[] => {
    // Служебная строка о закрепе: только выделить и удалить
    if (m.sys) {
      return [
        { icon: 'check', label: 'Выделить', run: () => setSelected(new Set([String(m.id)])) },
        { icon: 'trash', label: 'Удалить', danger: true, tail: true, page: 'delete', run: () => setDel([m.id]) },
      ];
    }
    const mine = m.user === me;
    const items: MenuItem[] = [{ icon: 'reply', label: 'Ответить', run: () => startReply(m) }];
    if (mine) items.push({ icon: 'pencil', label: 'Изменить', tail: true, run: () => startEdit(m) });
    items.push(
      ...(m.content ? [{ icon: 'copy' as IconName, label: 'Копировать текст', run: () => copy(m.content) }] : []),
      ...(photo ? photoItems(photo) : []),
      { icon: m.pinned ? 'pin-off' : 'pin', label: m.pinned ? 'Открепить' : 'Закрепить', run: () => chat.pin(m.id, !m.pinned) },
      { icon: 'reply', label: 'Переслать', flip: true, run: () => setFwd([m.id]) },
      { icon: 'check', label: 'Выделить', run: () => setSelected(new Set([String(m.id)])) },
      { icon: 'trash', label: 'Удалить', danger: true, tail: true, page: 'delete', run: () => setDel([m.id]) },
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

  // Куда переслать: все текстовые чаты и чаты голосовых каналов на серверах пользователя
  const targets = app.servers.flatMap((s) =>
    s.channels.map((c) => ({
      room: c.room,
      server: s,
      channel: c,
      label: c.kind === 'voice' ? `Чат «${c.name}»` : `#${c.name}`,
      icon: (c.kind === 'voice' ? 'voice' : 'chats') as IconName,
    })),
  );
  const doForward = (t: (typeof targets)[number]) => {
    if (!fwd) return;
    const ids = [...fwd].sort((a, b) => Number(a) - Number(b));
    const label = `${t.server.name} · ${t.label}`;
    chat.forward(ids, t.room, (_to, count) => {
      app.notify(count ? `Переслано: ${msgs(count)} → ${label}` : 'Не удалось переслать', count ? 'success' : 'error');
      // переслали в другой чат — переходим туда (через адрес: его разбирают и десктоп, и телефон)
      if (!count || t.room === channel.room) return;
      const to = paths.channel(t.server.id, t.channel.id, t.channel.kind === 'voice');
      if (location.pathname === to) return;
      history.pushState({ prev: location.pathname }, '', to);
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    setFwd(null);
    setSelected(null);
  };

  const replyTarget = reply ?? editing;
  const bar = replyTarget ? (
    <div className="composer-bar">
      <Icon name={editing ? 'pencil' : 'reply'} size={18} />
      {replyTarget.attachments?.[0] && <img className="rq-thumb" src={replyTarget.attachments[0].url} alt="" draggable={false} />}
      <button type="button" className="cb-text" onClick={() => jump(replyTarget.id)}>
        <b>{editing ? 'Редактирование' : <>Ответ <DisplayName name={replyTarget.user} /></>}</b>
        <span>{previewText(replyTarget)}</span>
      </button>
      <button type="button" className="icon-btn" title="Отменить" onClick={cancelBar}>
        <Icon name="close" size={18} />
      </button>
    </div>
  ) : null;

  const list = pinnedView ? chat.pinned : chat.messages;

  // Чат открыт и вкладка видна — отмечаем прочитанным до последнего сообщения
  const lastId = chat.messages.length ? chat.messages[chat.messages.length - 1].id : 0;
  useEffect(() => {
    const mark = () => document.visibilityState === 'visible' && lastId && chat.markRead(lastId);
    mark();
    document.addEventListener('visibilitychange', mark);
    return () => document.removeEventListener('visibilitychange', mark);
  }, [lastId, chat.markRead]); // eslint-disable-line react-hooks/exhaustive-deps
  // Свои сообщения прочитаны, если кто-то другой дочитал до них
  const readUpTo = Object.entries(chat.reads).reduce((acc, [u, id]) => (u !== me && id > acc ? id : acc), 0);
  // Линия «Новое»: что было прочитано в момент открытия чата (фиксируем один раз, когда пришла история)
  // Считаем прямо при отрисовке (а не эффектом после неё): иначе лента сначала рисовалась без линии,
  // а через кадр линия вставлялась и всё под ней дёргалось вниз.
  // line — была ли линия при открытии. Если всё было прочитано, а чат на экране, отметка идёт вслед за новыми сообщениями:
  // пришедшее при открытом чате уже прочитано, линия «Новое» над ним не нужна (раньше она появлялась на каждом входящем)
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

  // Плашка закрепа под шапкой: последний закреп не ниже текущего места в ленте
  const rootRef = useRef<HTMLDivElement>(null);
  const [viewPin, setViewPin] = useState(0);
  const pins = chat.pinned;
  let pinIdx = pins.findIndex((p) => Number(p.id) === viewPin);
  if (pinIdx < 0 && pins.length) {
    // в загруженной ленте подходящего нет: последний закреп старше загруженной истории, иначе первый
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
  /** Куда перешли по прошлому нажатию на плашку. */
  const lastPinJump = useRef<Id | null>(null);
  // Нажатие: к показанному закрепу; если к нему уже перешли и он на экране — к предыдущему (по кругу)
  const openPin = () => {
    if (!shownPin) return;
    const again = String(lastPinJump.current) === String(shownPin.id) && isOnScreen(shownPin.id);
    const target = again && pins.length > 1 ? pins[(pinIdx - 1 + pins.length) % pins.length] : shownPin;
    lastPinJump.current = target.id;
    // Плашка сразу показывает закреп, к которому перешли (ленту могло и не прокрутить)
    setViewPin(Number(target.id));
    jump(target.id);
  };
  // Нумерация по порядку: самый старый закреп — №1, выше по ленте номер убывает
  const pinNo = pinIdx + 1;
  const banner = showBanner ? (
    <div className="pin-banner">
      {/* До 4 закрепов — по полоске на каждый; больше — число и одна полоса */}
      {pins.length > 4 ? (
        <>
          <span className="pb-count" title={`Закреп ${pinNo} из ${pins.length}`}>{pinNo}</span>
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
      {shownPin.attachments?.[0] && (
        <img className="rq-thumb pb-thumb" src={shownPin.attachments[0].url} alt="" draggable={false} onClick={openPin} />
      )}
      <button type="button" className="pb-body" onClick={openPin} title="Перейти к сообщению">
        <b>Закреплённое сообщение</b>
        <span>
          {shownPin.fwd ? <>Переслано от <DisplayName name={shownPin.fwd.user} />: </> : null}
          {previewText(shownPin)}
        </span>
      </button>
      <button type="button" className="icon-btn pb-unpin" title="Открепить" aria-label="Открепить сообщение" onClick={() => chat.pin(shownPin.id, false)}>
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
        me={me}
        empty={
          pinnedView ? (
            <>
              <b>Закреплённых пока нет</b>
              Закрепите важное сообщение через меню по правой кнопке или долгому нажатию.
            </>
          ) : (
            <>
              <b>{chat.connected ? `Добро пожаловать в ${title}` : 'Подключаемся к чату…'}</b>
              {chat.connected ? 'Сообщений пока нет. Напишите первым' : 'Нет связи с сервером'}
            </>
          )
        }
        onMenu={(m, x, y, row, lift) => {
          // фото, на котором держали палец / нажали ПКМ (иначе — первое в сообщении)
          const img = document.elementFromPoint(x, y)?.closest('img');
          const urls = (m.attachments ?? []).map((a) => a.url);
          const hit = img ? urls.find((u) => img.src.endsWith(u) || img.src === u) : undefined;
          const photo = hit ?? urls[0];
          if (photo && touchDevice()) prefetchPhoto(photo);
          setMenu({ m, x, y, row, lift, photo });
        }}
        onReply={startReply}
        selecting={!!selected}
        selected={selected ?? undefined}
        onToggle={toggle}
        onJump={jump}
        focus={focus}
        readUpTo={readUpTo}
        newAfter={pinnedView ? 0 : newAfter}
        onView={setViewPin}
      />
      {selected ? (
        <div className="composer select-bar">
          <button className="icon-btn" title="Отменить выделение" onClick={() => setSelected(null)}>
            <Icon name="close" />
          </button>
          <span className="sb-count">{selected.size ? `Выбрано: ${selected.size}` : 'Выберите сообщения'}</span>
          <button className="sb-act" disabled={!selected.size} title="Копировать" onClick={() => {
            copy(selList.map((m) => (selList.length > 1 ? `${m.user}: ${previewText(m)}` : previewText(m))).join('\n'));
            setSelected(null);
          }}>
            <Icon name="copy" />
          </button>
          <button className="sb-act" disabled={!selected.size || selList.some((m) => m.sys)} title={selList.some((m) => m.sys) ? 'Строки о закрепе не пересылаются' : 'Переслать'} onClick={() => setFwd(selList.map((m) => m.id))}>
            <Icon name="reply" className="flip" />
          </button>
          <button className="sb-act danger" disabled={!selected.size} title="Удалить" onClick={() => setDel(selList.map((m) => m.id))}>
            <Icon name="trash" />
          </button>
        </div>
      ) : pinnedView ? (
        <div className="composer pinned-bar">
          <Icon name="pin-fill" size={18} />
          <span className="sb-count">Закреплённые · {chat.pinned.length}</span>
          <button className="btn-chip" onClick={() => chat.setView('all')}>
            К чату
          </button>
        </div>
      ) : (
        <Composer
          placeholder={compact ? 'Сообщение' : `Написать в ${title}`}
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
              // После правки в поле возвращается отложенный черновик
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
          onClose={() => setMenu(null)}
        />
      )}

      {del && (
        <Modal title={del.length > 1 ? `Удалить ${msgs(del.length)}?` : 'Удалить сообщение?'} onClose={() => setDel(null)}>
          <p className="chat-modal-text">
            {delMine
              ? 'Можно убрать только у себя или удалить у всех участников чата.'
              : 'Чужие сообщения можно убрать только у себя, у остальных они останутся.'}
          </p>
          <div className="chat-modal-actions">
            {delMine && (
              <button className="btn btn-danger" onClick={() => doDelete('all')}>
                Удалить у всех
              </button>
            )}
            <button className={'btn ' + (delMine ? 'btn-ghost' : 'btn-danger')} onClick={() => doDelete('me')}>
              Удалить у меня
            </button>
            <button className="btn btn-ghost" onClick={() => setDel(null)}>
              Отмена
            </button>
          </div>
        </Modal>
      )}

      {fwd && (
        <Modal title={`Переслать ${msgs(fwd.length)}`} onClose={() => setFwd(null)}>
          <div className="fwd-list">
            {targets.map((t) => (
              <button key={t.room} className="fwd-item" onClick={() => doForward(t)}>
                <span className="fwd-srv" style={{ background: t.server.gradient }}>
                  {t.server.short}
                </span>
                <span className="fwd-text">
                  <b>
                    <Icon name={t.icon} size={16} /> {t.label}
                  </b>
                  <span>{t.server.name}</span>
                </span>
                {t.room === channel.room && <span className="fwd-here">этот чат</span>}
              </button>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}
