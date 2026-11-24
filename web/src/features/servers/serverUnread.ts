import { useEffect, useState } from 'react';
import { api } from '../../shared/api';
import { UNREAD_CHANGED } from '../chat/useChat';

export type ServerUnread = Record<string, { count: number; mentions: number }>;

/** Unread counts per server from the server; reloaded on my read marks, on new messages elsewhere and on return. */
export function useServerUnread(serverId: string, readA: number, readB: number): ServerUnread {
  const [data, setData] = useState<ServerUnread>({});
  const mark = `${serverId}:${readA}:${readB}`;
  useEffect(() => {
    let off = false;
    const load = () => void api<{ servers: ServerUnread }>('/api/unread').then((r) => !off && setData(r.servers), () => undefined);
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
  }, [mark]);
  return data;
}
