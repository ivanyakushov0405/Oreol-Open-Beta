import { useOpenChat } from './notifications';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { AppState } from './App';
import { Icon, type IconName } from './icons';
import type { Channel, ChatMessage } from './mock';
import { Composer, DisplayName, MessageList } from './ui';

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
  run: () => void;
}

function MessageMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y, origin: 'top left' });
  // Меню не вылезает за экран: прижимаем к краям и открываем вверх/влево, если снизу/справа мало места
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const pad = 8;
    const up = y + h + pad > innerHeight;
    const left = Math.max(pad, Math.min(x, innerWidth - w - pad));
    const top = Math.max(pad, up ? y - h : y);
    setPos({ left, top, origin: `${up ? 'bottom' : 'top'} ${left < x - w / 2 ? 'right' : 'left'}` });
  }, [x, y]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <>
      <div className="msg-menu-backdrop" onClick={onClose} onContextMenu={(e) => (e.preventDefault(), onClose())} />
      <div ref={ref} className="msg-menu" role="menu" style={{ left: pos.left, top: pos.top, transformOrigin: pos.origin }}>
        {items.map((it) => (
          <button
            key={it.label}
            role="menuitem"
            className={'msg-menu-item' + (it.danger ? ' danger' : '')}
            onClick={() => {
              onClose();
              it.run();
            }}
          >
            <Icon name={it.icon} size={18} className={it.flip ? 'flip' : undefined} />
            <span>{it.label}</span>
          </button>
        ))}
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
  useOpenChat(channel.room);

  const [menu, setMenu] = useState<{ m: ChatMessage; x: number; y: number } | null>(null);
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
      app.notify('Сообщение слишком старое — его нет в загруженной истории');
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

  const menuItems = (m: ChatMessage): MenuItem[] => {
    // Служебная строка о закрепе: только выделить и удалить
    if (m.sys) {
      return [
        { icon: 'check', label: 'Выделить', run: () => setSelected(new Set([String(m.id)])) },
        { icon: 'trash', label: 'Удалить', danger: true, run: () => setDel([m.id]) },
      ];
    }
    const mine = m.user === me;
    const items: MenuItem[] = [{ icon: 'reply', label: 'Ответить', run: () => startReply(m) }];
    if (mine) items.push({ icon: 'pencil', label: 'Изменить', run: () => startEdit(m) });
    items.push(
      { icon: 'copy', label: 'Копировать текст', run: () => copy(m.content) },
      { icon: m.pinned ? 'pin-off' : 'pin', label: m.pinned ? 'Открепить' : 'Закрепить', run: () => chat.pin(m.id, !m.pinned) },
      { icon: 'reply', label: 'Переслать', flip: true, run: () => setFwd([m.id]) },
      { icon: 'check', label: 'Выделить', run: () => setSelected(new Set([String(m.id)])) },
      { icon: 'trash', label: 'Удалить', danger: true, run: () => setDel([m.id]) },
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
      label: c.kind === 'voice' ? `Чат «${c.name}»` : `#${c.name}`,
      icon: (c.kind === 'voice' ? 'voice' : 'chats') as IconName,
    })),
  );
  const doForward = (room: string, label: string) => {
    if (!fwd) return;
    const ids = [...fwd].sort((a, b) => Number(a) - Number(b));
    chat.forward(ids, room, (_to, count) => app.notify(count ? `Переслано: ${msgs(count)} → ${label}` : 'Не удалось переслать', count ? 'success' : 'error'));
    setFwd(null);
    setSelected(null);
  };

  const replyTarget = reply ?? editing;
  const bar = replyTarget ? (
    <div className="composer-bar">
      <Icon name={editing ? 'pencil' : 'reply'} size={18} />
      <button type="button" className="cb-text" onClick={() => jump(replyTarget.id)}>
        <b>{editing ? 'Редактирование' : <>Ответ <DisplayName name={replyTarget.user} /></>}</b>
        <span>{replyTarget.content}</span>
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
  const [mark, setMark] = useState<{ room: string; id: number } | null>(null);
  let newAfter = mark?.room === channel.room ? mark.id : 0;
  if (mark?.room !== channel.room && chat.room === channel.room) {
    newAfter = chat.myRead;
    setMark({ room: channel.room, id: chat.myRead });
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
      <button type="button" className="pb-body" onClick={openPin} title="Перейти к сообщению">
        <b>Закреплённое сообщение{pins.length > 1 ? ` #${pinNo}` : ''}</b>
        <span>
          {shownPin.fwd ? <>Переслано от <DisplayName name={shownPin.fwd.user} />: </> : null}
          {shownPin.content}
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
              Закрепите важное сообщение — через меню по правой кнопке или долгому нажатию.
            </>
          ) : (
            <>
              <b>{chat.connected ? `Добро пожаловать в ${title}` : 'Подключаемся к чату…'}</b>
              {chat.connected ? 'Сообщений пока нет — напишите первым' : 'Нет связи с сервером'}
            </>
          )
        }
        onMenu={(m, x, y) => setMenu({ m, x, y })}
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
            copy(selList.map((m) => (selList.length > 1 ? `${m.user}: ${m.content}` : m.content)).join('\n'));
            setSelected(null);
          }}>
            <Icon name="copy" />
          </button>
          <button className="sb-act" disabled={!selected.size} title="Переслать" onClick={() => setFwd(selList.map((m) => m.id))}>
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
          onSend={(text) => {
            if (editing) {
              const t = text.trim();
              if (!t) return false;
              if (t !== editing.content) chat.edit(editing.id, t);
              setEditing(null);
              // После правки в поле возвращается отложенный черновик
              if (stash.current) window.setTimeout(() => seedText(stash.current), 0);
              return true;
            }
            const ok = chat.send(text, reply?.id ?? null);
            if (ok) setReply(null);
            return ok;
          }}
          onTyping={chat.notifyTyping}
          disabled={!chat.connected}
        />
      )}

      {menu && <MessageMenu x={menu.x} y={menu.y} items={menuItems(menu.m)} onClose={() => setMenu(null)} />}

      {del && (
        <Modal title={del.length > 1 ? `Удалить ${msgs(del.length)}?` : 'Удалить сообщение?'} onClose={() => setDel(null)}>
          <p className="chat-modal-text">
            {delMine
              ? 'Можно убрать только у себя или удалить у всех участников чата.'
              : 'Чужие сообщения можно убрать только у себя — у остальных они останутся.'}
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
              <button key={t.room} className="fwd-item" onClick={() => doForward(t.room, `${t.server.name} · ${t.label}`)}>
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
