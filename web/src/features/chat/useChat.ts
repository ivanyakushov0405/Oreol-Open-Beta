import { useCallback, useEffect, useRef, useState } from 'react';
import { getToken, putUser, type PublicUser } from '../../shared/api';
import { previewText, type ChatMessage, type Status } from '../../shared/model';

type ServerEvent =
  | { type: 'history'; messages: ChatMessage[]; pinned?: ChatMessage[]; reads?: Record<string, number> }
  | { type: 'read'; user: string; id: number }
  | { type: 'message'; message: ChatMessage }
  | { type: 'update'; message: ChatMessage }
  | { type: 'deleted'; ids: (number | string)[] }
  | { type: 'forwarded'; to: string; count: number }
  | { type: 'typing'; user: string }
  | { type: 'presence'; statuses: Record<string, Status> }
  | { type: 'profile'; user: PublicUser };

const TYPING_TTL = 3500;

/** Реальный чат комнаты: история из SQLite, новые сообщения, «печатает», статусы подключённых. */
/** Длительность анимации удаления сообщения (как у @keyframes msg-out). */
const MSG_OUT_MS = 450;

export function useChat(room: string | null, user: string) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  /** Все закреплённые в комнате (не только из загруженной истории). */
  const [pinned, setPinned] = useState<ChatMessage[]>([]);
  /** Что показывает лента: весь чат или только закреплённые. */
  const [view, setView] = useState<'all' | 'pinned'>('all');
  const [statuses, setStatuses] = useState<Record<string, Status>>({});
  const [typing, setTyping] = useState<Record<string, number>>({});
  const [connected, setConnected] = useState(false);
  /** До какого сообщения дочитал каждый участник комнаты — для галочек «прочитано». */
  const [reads, setReads] = useState<Record<string, number>>({});
  const readSent = useRef(0);
  /** Новичок в чате (ни разу не отмечал прочитанное): история до его прихода не считается непрочитанной. */
  const [floor, setFloor] = useState(0);
  /** Комната, чья история сейчас загружена (null — ещё не пришла). */
  const [loaded, setLoaded] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const lastTypingSent = useRef(0);

  useEffect(() => {
    if (!room || !user) return;
    setMessages([]);
    setPinned([]);
    setReads({});
    setFloor(0);
    setLoaded(null);
    readSent.current = 0;
    setView('all');
    setTyping({});
    setConnected(false);
    let closed = false;
    let retry: number | undefined;
    let attempt = 0;

    const open = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      // Кто пишет — сервер узнаёт по токену сессии, а не по имени из адреса
      const ws = new WebSocket(`${proto}://${location.host}/api/ws/${room}?token=${encodeURIComponent(getToken() ?? '')}`);
      wsRef.current = ws;
      ws.onopen = () => {
        attempt = 0;
        setConnected(true);
      };
      ws.onmessage = (e) => {
        const ev = JSON.parse(e.data) as ServerEvent;
        if (ev.type === 'history') {
          setMessages(ev.messages);
          setLoaded(room);
          setPinned(ev.pinned ?? ev.messages.filter((m) => m.pinned));
          setReads(ev.reads ?? {});
          readSent.current = ev.reads?.[user] ?? 0;
          if (ev.reads?.[user] == null) {
            // запоминаем «точку входа» на устройстве, чтобы после перезагрузки старое снова не стало новым
            const key = `oreol.chatFloor.${user}.${room}`;
            const saved = localStorage.getItem(key);
            let f = Number(saved) || 0;
            if (saved == null) {
              f = ev.messages.length ? Number(ev.messages[ev.messages.length - 1].id) || 0 : 0;
              try {
                localStorage.setItem(key, String(f));
              } catch {
                /* хранилище недоступно */
              }
            }
            setFloor(f);
          }
        } else if (ev.type === 'read') {
          setReads((r) => (ev.id > (r[ev.user] ?? 0) ? { ...r, [ev.user]: ev.id } : r));
        } else if (ev.type === 'update') {
          const m = ev.message;
          // правка/закреп: само сообщение и короткие копии в ответах на него
          const patch = (list: ChatMessage[]) =>
            list.map((x) =>
              x.id === m.id ? m : x.reply && x.reply.id === m.id ? { ...x, reply: { id: m.id, user: m.user, content: previewText(m).slice(0, 200), photo: m.attachments?.[0]?.url ?? null } } : x,
            );
          setMessages(patch);
          setPinned((p) => {
            const rest = patch(p).filter((x) => x.id !== m.id);
            return m.pinned ? [...rest, m].sort((a, b) => Number(a.id) - Number(b.id)) : rest;
          });
        } else if (ev.type === 'deleted') {
          const gone = new Set(ev.ids.map(String));
          const drop = (list: ChatMessage[]) => {
            // удалённые ответы больше не считаются у исходных сообщений
            const less = new Map<string, number>();
            list.forEach((x) => {
              if (gone.has(String(x.id)) && x.reply && !x.sys) less.set(String(x.reply.id), (less.get(String(x.reply.id)) ?? 0) + 1);
            });
            return list
              .map((x) => (less.has(String(x.id)) ? { ...x, replies: Math.max(0, (x.replies ?? 0) - (less.get(String(x.id)) ?? 0)) } : x))
              .filter((x) => !gone.has(String(x.id)))
              .map((x) => (x.reply && gone.has(String(x.reply.id)) ? { ...x, reply: { id: x.reply.id, deleted: true } } : x));
          };
          // сначала сообщение уходит с анимацией (см. .msg-out), потом исчезает из ленты
          setMessages((list) => list.map((x) => (gone.has(String(x.id)) ? { ...x, leaving: true } : x)));
          setPinned(drop);
          window.setTimeout(() => setMessages(drop), MSG_OUT_MS);
        } else if (ev.type === 'forwarded') {
          onForwarded.current?.(ev.to, ev.count);
        } else if (ev.type === 'message') {
          const nm = ev.message;
          // новый ответ — +1 к счётчику ответов у исходного сообщения
          const bump = (list: ChatMessage[]) =>
            nm.reply && !nm.sys ? list.map((x) => (String(x.id) === String(nm.reply!.id) ? { ...x, replies: (x.replies ?? 0) + 1 } : x)) : list;
          setMessages((m) => [...bump(m), nm]);
          setPinned(bump);
          setTyping((t) => {
            const { [ev.message.user]: _drop, ...rest } = t;
            void _drop;
            return rest;
          });
        } else if (ev.type === 'typing') setTyping((t) => ({ ...t, [ev.user]: Date.now() }));
        else if (ev.type === 'presence') setStatuses(ev.statuses);
        else if (ev.type === 'profile') putUser(ev.user);
      };
      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        attempt += 1;
        retry = window.setTimeout(open, Math.min(1000 * attempt, 8000));
      };
    };
    open();

    return () => {
      closed = true;
      window.clearTimeout(retry);
      wsRef.current?.close();
      wsRef.current = null;
      setMessages([]);
      setPinned([]);
      setReads({});
      setTyping({});
    };
  }, [room, user]);

  // Чистим устаревшие «печатает».
  useEffect(() => {
    const id = window.setInterval(() => {
      setTyping((t) => {
        const now = Date.now();
        const next = Object.fromEntries(Object.entries(t).filter(([, at]) => now - at < TYPING_TTL));
        return Object.keys(next).length === Object.keys(t).length ? t : next;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  const raw = useCallback((payload: object) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(payload));
    return true;
  }, []);

  const send = useCallback(
    (content: string, replyTo?: number | string | null, attachments: number[] = []) => {
      const text = content.trim();
      if (!text && !attachments.length) return false;
      return raw({ type: 'message', content: text, reply_to: replyTo ?? null, attachments });
    },
    [raw],
  );
  /** Изменить своё сообщение. */
  const edit = useCallback((id: number | string, content: string) => !!content.trim() && raw({ type: 'edit', id, content: content.trim() }), [raw]);
  /** Удалить: у себя (любые) или у всех (только свои — проверяет сервер). */
  const remove = useCallback((ids: (number | string)[], scope: 'me' | 'all') => raw({ type: 'delete', ids, scope }), [raw]);
  const pin = useCallback((id: number | string, on: boolean) => raw({ type: 'pin', id, pinned: on }), [raw]);
  /** Переслать сообщения в другую комнату; ответ сервера придёт в onForwarded. */
  const onForwarded = useRef<((to: string, count: number) => void) | null>(null);
  const forward = useCallback(
    (ids: (number | string)[], to: string, done?: (to: string, count: number) => void) => {
      onForwarded.current = done ?? null;
      return raw({ type: 'forward', ids, to });
    },
    [raw],
  );

  /** Отметить комнату прочитанной до сообщения id (отправляется только при сдвиге вперёд). */
  const markRead = useCallback(
    (id: number | string) => {
      const n = Number(id);
      if (!n || n <= readSent.current) return;
      if (raw({ type: 'read', id: n })) readSent.current = n;
    },
    [raw],
  );

  const notifyTyping = useCallback(() => {
    const ws = wsRef.current;
    const now = Date.now();
    if (!ws || ws.readyState !== WebSocket.OPEN || now - lastTypingSent.current < 2000) return;
    lastTypingSent.current = now;
    ws.send(JSON.stringify({ type: 'typing' }));
  }, []);

  return {
    messages,
    /** Комната загруженной истории: пока она не совпала с открытой, в messages может быть прошлый чат. */
    room: loaded,
    pinned,
    reads,
    /** До какого сообщения прочитал сам пользователь (с учётом «точки входа» новичка). */
    myRead: Math.max(reads[user] ?? 0, floor),
    markRead,
    view,
    setView,
    statuses,
    typingUsers: Object.keys(typing),
    connected,
    send,
    edit,
    remove,
    pin,
    forward,
    notifyTyping,
  };
}
