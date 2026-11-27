import { useCallback, useEffect, useRef, useState } from 'react';
import { api, putUser, type PublicUser } from '../../shared/api';
import { voiceNow } from '../voice/voiceNow';
import { firstPhotoUrl, previewText, type ChatMessage, type Status } from '../../shared/model';

type ServerEvent =
  | { type: 'unread'; room?: string; message?: ChatMessage | null }
  | { type: 'history'; messages: ChatMessage[]; pinned?: ChatMessage[]; reads?: Record<string, number> }
  | { type: 'read'; user: string; id: number }
  | { type: 'message'; message: ChatMessage }
  | { type: 'update'; message: ChatMessage }
  | { type: 'reactions'; id: number | string; reactions: ChatMessage['reactions'] }
  | { type: 'deleted'; ids: (number | string)[] }
  | { type: 'forwarded'; to: string; count: number }
  | { type: 'typing'; user: string }
  | { type: 'presence'; statuses: Record<string, Status> }
  | { type: 'profile'; user: PublicUser }
  | { type: 'voice'; user: string };

/**
 * Voice join/leave goes to everyone through the chat socket at once, otherwise others only saw it on the next poll.
 * One open socket sends our own event; others' events become a window event that triggers a roster refresh.
 */
export const VOICE_LOCAL = 'oreol:voice-local';
export const VOICE_CHANGED = 'oreol:voice';
let voiceSentAt = 0;

const TYPING_TTL = 3500;
const PAGE = 100;

const MSG_OUT_MS = 450;

const chatCache = new Map<string, { messages: ChatMessage[]; pinned: ChatMessage[]; reads: Record<string, number> }>();

/** Fired when a message lands in another chat of one of my servers: the rail refreshes its badges. */
export const UNREAD_CHANGED = 'oreol:unread';
/** Every live message of any of my chats, from whichever socket got it first (alerts dedupe by id). */
export const NEW_MESSAGE = 'oreol:new-message';
export type NewMessage = { room: string; message: ChatMessage };
const announce = (room: string, message: ChatMessage) =>
  window.dispatchEvent(new CustomEvent<NewMessage>(NEW_MESSAGE, { detail: { room, message } }));

/** On a phone the app in the background means the user left: they show offline (desktop tabs stay online). */
const phone = () => matchMedia('(pointer: coarse)').matches;
const away = () => phone() && document.visibilityState === 'hidden' && !voiceNow.on;

export function useChat(room: string | null, user: string) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pinned, setPinned] = useState<ChatMessage[]>([]);
  const [view, setView] = useState<'all' | 'pinned'>('all');
  /** Request for ChatBody to scroll to a message, set by reveal(). */
  const [jumpReq, setJumpReq] = useState<{ id: number; n: number } | null>(null);
  const [statuses, setStatuses] = useState<Record<string, Status>>({});
  const [typing, setTyping] = useState<Record<string, number>>({});
  const [connected, setConnected] = useState(false);
  const [reads, setReads] = useState<Record<string, number>>({});
  const readSent = useRef(0);
  /** Newcomer to the chat (never marked anything read): history before they joined does not count as unread. */
  const [floor, setFloor] = useState(0);
  const [loaded, setLoaded] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const lastTypingSent = useRef(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const olderBusy = useRef(false);
  const msgsRef = useRef(messages);
  msgsRef.current = messages;
  const revive = useRef<() => void>(() => {});
  const roomRef = useRef(room);
  roomRef.current = room;

  useEffect(() => {
    const send = () => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN || Date.now() - voiceSentAt < 300) return;
      voiceSentAt = Date.now();
      ws.send(JSON.stringify({ type: 'voice' }));
    };
    window.addEventListener(VOICE_LOCAL, send);
    return () => window.removeEventListener(VOICE_LOCAL, send);
  }, []);

  useEffect(() => {
    if (!room || !user) return;
    // A room opened before shows its last known list right away while the socket (re)connects.
    const cached = chatCache.get(room);
    setMessages(cached?.messages ?? []);
    setPinned(cached?.pinned ?? []);
    setReads(cached?.reads ?? {});
    setFloor(0);
    setHasMore((cached?.messages.length ?? 0) >= PAGE);
    setLoaded(cached ? room : null);
    readSent.current = 0;
    setView('all');
    setTyping({});
    setConnected(false);
    let closed = false;
    let retry: number | undefined;
    let attempt = 0;

    const open = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/api/ws/${room}`);
      wsRef.current = ws;
      ws.onopen = () => {
        attempt = 0;
        setConnected(true);
        if (away()) ws.send(JSON.stringify({ type: 'hidden', on: true }));
      };
      ws.onmessage = (e) => {
        const ev = JSON.parse(e.data) as ServerEvent;
        if (ev.type === 'history') {
          // On reconnect keep the older messages already loaded.
          const first = ev.messages.length ? Number(ev.messages[0].id) : Infinity;
          const older = msgsRef.current.filter((m) => Number(m.id) < first && !m.leaving);
          setMessages(older.length ? [...older, ...ev.messages] : ev.messages);
          if (!older.length) setHasMore(ev.messages.length >= PAGE);
          setLoaded(room);
          setPinned(ev.pinned ?? ev.messages.filter((m) => m.pinned));
          setReads(ev.reads ?? {});
          readSent.current = ev.reads?.[user] ?? 0;
          if (ev.reads?.[user] == null) {
            // Remember the join point on this device so old messages do not become new again after reload.
            const key = `oreol.chatFloor.${user}.${room}`;
            const saved = localStorage.getItem(key);
            let f = Number(saved) || 0;
            if (saved == null) {
              f = ev.messages.length ? Number(ev.messages[ev.messages.length - 1].id) || 0 : 0;
              try {
                localStorage.setItem(key, String(f));
              } catch {
                /* ignore */
              }
            }
            setFloor(f);
          }
        } else if (ev.type === 'read') {
          setReads((r) => (ev.id > (r[ev.user] ?? 0) ? { ...r, [ev.user]: ev.id } : r));
        } else if (ev.type === 'reactions') {
          const set = (list: ChatMessage[]) => list.map((x) => (String(x.id) === String(ev.id) ? { ...x, reactions: ev.reactions } : x));
          setMessages(set);
          setPinned(set);
        } else if (ev.type === 'update') {
          const m = ev.message;
          const patch = (list: ChatMessage[]) =>
            list.map((x) =>
              x.id === m.id ? m : x.reply && x.reply.id === m.id ? { ...x, reply: { id: m.id, user: m.user, content: previewText(m).slice(0, 200), photo: firstPhotoUrl(m.attachments) ?? null } } : x,
            );
          setMessages(patch);
          setPinned((p) => {
            const rest = patch(p).filter((x) => x.id !== m.id);
            return m.pinned ? [...rest, m].sort((a, b) => Number(a.id) - Number(b.id)) : rest;
          });
        } else if (ev.type === 'deleted') {
          const gone = new Set(ev.ids.map(String));
          const drop = (list: ChatMessage[]) => {
            const less = new Map<string, number>();
            list.forEach((x) => {
              if (gone.has(String(x.id)) && x.reply && !x.sys) less.set(String(x.reply.id), (less.get(String(x.reply.id)) ?? 0) + 1);
            });
            return list
              .map((x) => (less.has(String(x.id)) ? { ...x, replies: Math.max(0, (x.replies ?? 0) - (less.get(String(x.id)) ?? 0)) } : x))
              .filter((x) => !gone.has(String(x.id)))
              .map((x) => (x.reply && gone.has(String(x.reply.id)) ? { ...x, reply: { id: x.reply.id, deleted: true } } : x));
          };
          // The message animates out first (see .msg-out), then leaves the list.
          setMessages((list) => list.map((x) => (gone.has(String(x.id)) ? { ...x, leaving: true } : x)));
          setPinned(drop);
          window.setTimeout(() => setMessages(drop), MSG_OUT_MS);
        } else if (ev.type === 'forwarded') {
          onForwarded.current?.(ev.to, ev.count);
        } else if (ev.type === 'message') {
          const nm = ev.message;
          announce(room, nm);
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
        else if (ev.type === 'voice') window.dispatchEvent(new Event(VOICE_CHANGED));
        else if (ev.type === 'unread') {
          window.dispatchEvent(new Event(UNREAD_CHANGED));
          if (ev.room && ev.message) announce(ev.room, ev.message);
        }
      };
      ws.onclose = () => {
        // An old socket already replaced by a new one (see wake) must not touch state.
        if (wsRef.current !== ws) return;
        setConnected(false);
        if (closed) return;
        attempt += 1;
        retry = window.setTimeout(open, Math.min(1000 * attempt, 8000));
      };
    };
    open();
    // Back in the app (the phone killed the socket in the background) or online again:
    // reconnect now instead of waiting for the retry timer, which could reach 8 s.
    const wake = () => {
      const ws0 = wsRef.current;
      if (ws0?.readyState === WebSocket.OPEN && phone()) ws0.send(JSON.stringify({ type: 'hidden', on: away() }));
      if (closed || document.visibilityState !== 'visible') return;
      const ws = wsRef.current;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
      window.clearTimeout(retry);
      attempt = 0;
      open();
    };
    // A socket that looks open but is dead: drop it without waiting for its close, which can take long, and reopen.
    revive.current = () => {
      if (closed) return;
      const ws = wsRef.current;
      wsRef.current = null;
      ws?.close();
      window.clearTimeout(retry);
      attempt = 0;
      open();
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    window.addEventListener('pageshow', wake);

    return () => {
      closed = true;
      revive.current = () => {};
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
      window.removeEventListener('pageshow', wake);
      window.clearTimeout(retry);
      wsRef.current?.close();
      wsRef.current = null;
      setMessages([]);
      setPinned([]);
      setReads({});
      setTyping({});
    };
  }, [room, user]);

  useEffect(() => {
    if (room && loaded === room) chatCache.set(room, { messages: messages.filter((m) => !m.leaving), pinned, reads });
  }, [room, loaded, messages, pinned, reads]);

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
  const edit = useCallback((id: number | string, content: string) => !!content.trim() && raw({ type: 'edit', id, content: content.trim() }), [raw]);
  const remove = useCallback((ids: (number | string)[], scope: 'me' | 'all') => raw({ type: 'delete', ids, scope }), [raw]);
  const pin = useCallback((id: number | string, on: boolean) => raw({ type: 'pin', id, pinned: on }), [raw]);
  const react = useCallback((id: number | string, emoji: string) => raw({ type: 'react', id, emoji }), [raw]);
  const onForwarded = useRef<((to: string, count: number) => void) | null>(null);
  const forward = useCallback(
    (ids: (number | string)[], to: string, done?: (to: string, count: number) => void) => {
      onForwarded.current = done ?? null;
      return raw({ type: 'forward', ids, to });
    },
    [raw],
  );

  const readsRef = useRef(reads);
  readsRef.current = reads;
  const readCheck = useRef(0);
  useEffect(() => () => window.clearTimeout(readCheck.current), [room]);
  const markRead = useCallback(
    (id: number | string) => {
      const n = Number(id);
      const r = roomRef.current;
      if (!n || !r || n <= readSent.current) return;
      readSent.current = n;
      raw({ type: 'read', id: n });
      // The server echoes a mark that moved. A phone back from the background can hold a socket that still looks open
      // but delivers nothing: without the echo, send the mark over HTTP, and if it did move there, the socket is dead.
      window.clearTimeout(readCheck.current);
      readCheck.current = window.setTimeout(async () => {
        if (roomRef.current !== r || (readsRef.current[user] ?? 0) >= n) return;
        try {
          const res = await api<{ changed?: boolean }>(`/api/chat/${encodeURIComponent(r)}/read`, { method: 'POST', body: { id: n } });
          if (res.changed && roomRef.current === r) revive.current();
        } catch {
          if (roomRef.current === r && readSent.current === n) readSent.current = n - 1;
        }
      }, 3000);
    },
    [raw, user],
  );

  const notifyTyping = useCallback(() => {
    const ws = wsRef.current;
    const now = Date.now();
    if (!ws || ws.readyState !== WebSocket.OPEN || now - lastTypingSent.current < 2000) return;
    lastTypingSent.current = now;
    ws.send(JSON.stringify({ type: 'typing' }));
  }, []);

  const loadOlder = useCallback(async () => {
    const r = roomRef.current;
    if (!r || olderBusy.current || !hasMore) return;
    const oldest = messages.find((m) => !m.leaving && Number(m.id) > 0);
    if (!oldest) return;
    olderBusy.current = true;
    setLoadingOlder(true);
    try {
      const d = await api<{ messages: ChatMessage[]; more: boolean }>(`/api/chat/${encodeURIComponent(r)}/history?before=${oldest.id}&limit=${PAGE}`);
      if (roomRef.current !== r) return;
      setMessages((prev) => {
        const have = new Set(prev.map((m) => String(m.id)));
        return [...d.messages.filter((m) => !have.has(String(m.id))), ...prev];
      });
      setHasMore(d.more);
    } catch {
      /* ignore */
    } finally {
      olderBusy.current = false;
      setLoadingOlder(false);
    }
  }, [messages, hasMore]);

  /** Loads history back to the message, then asks the open chat to scroll to it. False if it is gone. */
  const reveal = useCallback(async (id: number | string) => {
    const r = roomRef.current;
    const target = Number(id);
    if (!r || !target) return false;
    const has = () => msgsRef.current.some((m) => Number(m.id) === target);
    olderBusy.current = true;
    try {
      for (let i = 0; i < 25 && !has(); i++) {
        const oldest = msgsRef.current.find((m) => !m.leaving && Number(m.id) > 0);
        if (!oldest || Number(oldest.id) < target) break;
        const d = await api<{ messages: ChatMessage[]; more: boolean }>(`/api/chat/${encodeURIComponent(r)}/history?before=${oldest.id}&limit=200`);
        if (roomRef.current !== r) return false;
        const have = new Set(msgsRef.current.map((m) => String(m.id)));
        const merged = [...d.messages.filter((m) => !have.has(String(m.id))), ...msgsRef.current];
        msgsRef.current = merged;
        setMessages(merged);
        setHasMore(d.more);
        if (!d.more) break;
      }
    } catch {
      return false;
    } finally {
      olderBusy.current = false;
    }
    if (!has()) return false;
    setView('all');
    setJumpReq({ id: target, n: Date.now() });
    return true;
  }, []);

  return {
    messages,
    reveal,
    jumpReq,
    hasMore,
    loadingOlder,
    loadOlder,
    room: loaded,
    pinned,
    reads,
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
    react,
    forward,
    notifyTyping,
  };
}
