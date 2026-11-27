import { useEffect, useState } from 'react';
import { api } from '../../shared/api';
import { UNREAD_CHANGED } from '../chat/useChat';

export type ServerUnread = Record<string, { count: number; mentions: number }>;
export type UnreadSummary = { servers: ServerUnread; rooms: ServerUnread };

const EMPTY: UnreadSummary = { servers: {}, rooms: {} };
const keyOf = (user: string) => `oreol.unread.${user}`;
function saved(user: string): UnreadSummary {
  try {
    const v = JSON.parse(localStorage.getItem(keyOf(user)) || 'null') as UnreadSummary | null;
    return v?.servers && v.rooms ? v : EMPTY;
  } catch {
    return EMPTY;
  }
}

/** Unread counts per server and per room from the server; reloaded on my read marks, on new messages elsewhere and on return. */
export function useServerUnread(user: string, serverId: string, readA: number, readB: number): UnreadSummary {
  // The last known counts show right after a reload, until the request answers: otherwise the badges blink out.
  const [data, setData] = useState<UnreadSummary>(() => saved(user));
  const mark = `${serverId}:${readA}:${readB}`;
  useEffect(() => {
    let off = false;
    const load = () =>
      void api<Partial<UnreadSummary>>('/api/unread').then((r) => {
        if (off) return;
        const next = { servers: r.servers ?? {}, rooms: r.rooms ?? {} };
        setData(next);
        try {
          localStorage.setItem(keyOf(user), JSON.stringify(next));
        } catch {
          /* ignore */
        }
      }, () => undefined);
    load();
    const id = window.setInterval(load, 20000);
    // Both sockets get the nudge: one request for the pair.
    let soon: number | undefined;
    const nudge = () => {
      window.clearTimeout(soon);
      soon = window.setTimeout(load, 250);
    };
    const back = () => document.visibilityState === 'visible' && load();
    window.addEventListener(UNREAD_CHANGED, nudge);
    document.addEventListener('visibilitychange', back);
    return () => {
      off = true;
      window.clearInterval(id);
      window.clearTimeout(soon);
      window.removeEventListener(UNREAD_CHANGED, nudge);
      document.removeEventListener('visibilitychange', back);
    };
  }, [mark, user]);
  return data;
}
