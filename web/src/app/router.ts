import { useEffect, useRef } from 'react';

// History API routing without third-party libraries. Screen state is the source of truth and the URL is derived
// from it; on Back/Forward and on opening a link the state is restored from the URL.
// /                                   home (last server)
// /chats                              direct messages (desktop), Chats tab (mobile)
// /you                                You tab (mobile)
// /servers/:sid                       server
// /servers/:sid/:cid                  channel (text or voice)
// /servers/:sid/:cid/chat             voice channel chat
// /servers/:sid/members               members (mobile)
// /servers/:sid/settings[/:section]   server settings
// /settings[/:section]                user settings

export type Route =
  | { name: 'home' }
  | { name: 'chats' }
  | { name: 'you' }
  | { name: 'settings'; section?: string }
  | { name: 'server'; sid: string; cid?: string; sub?: 'chat' | 'members' | 'settings'; section?: string };

const seg = (s: string | undefined) => (s ? decodeURIComponent(s) : undefined);

export function parseRoute(path: string): Route {
  const p = path.replace(/\/+$/, '').split('/').filter(Boolean);
  if (!p.length) return { name: 'home' };
  if (p[0] === 'chats') return { name: 'chats' };
  if (p[0] === 'you') return { name: 'you' };
  if (p[0] === 'settings') return { name: 'settings', section: seg(p[1]) };
  if (p[0] === 'servers' && p[1]) {
    const sid = seg(p[1])!;
    if (p[2] === 'members') return { name: 'server', sid, sub: 'members' };
    if (p[2] === 'settings') return { name: 'server', sid, sub: 'settings', section: seg(p[3]) };
    if (p[2]) return { name: 'server', sid, cid: seg(p[2]), sub: p[3] === 'chat' ? 'chat' : undefined };
    return { name: 'server', sid };
  }
  return { name: 'home' };
}

const enc = encodeURIComponent;
export const paths = {
  chats: () => '/chats',
  you: () => '/you',
  settings: (section?: string | null) => (section ? `/settings/${enc(section)}` : '/settings'),
  server: (sid: string) => `/servers/${enc(sid)}`,
  channel: (sid: string, cid: string, chat = false) => `/servers/${enc(sid)}/${enc(cid)}${chat ? '/chat' : ''}`,
  members: (sid: string) => `/servers/${enc(sid)}/members`,
  serverSettings: (sid: string, section?: string | null) => `/servers/${enc(sid)}/settings${section ? `/${enc(section)}` : ''}`,
};

/** Moving "up": a nested screen closed (channel to server) or settings/members on top were closed. */
const OVERLAY = /(^|\/)(settings|members)(\/|$)/;
function isUp(from: string, to: string) {
  return from.startsWith(to + '/') || (OVERLAY.test(from) && !OVERLAY.test(to));
}

/** Waiting for the popstate caused by our own history.back(); the URL is left alone until it arrives. */
let backPending = false;
/**
 * The next URL change returns to where we came from (e.g. voice opened over settings or chat): go back in history
 * rather than push, otherwise the next jump into voice is taken for Back and closes the screen under it.
 */
let returnNext = false;
export function markReturn() {
  returnNext = true;
  forwardNext = false;
}
/** The next URL change is a forward move (a screen opened on top), even if the URL matches the previous entry. */
let forwardNext = false;
export function markForward() {
  forwardNext = true;
  returnNext = false;
}

/**
 * Binds the URL to screen state.
 * path: URL for the current state; apply: bring state to a URL (load, Back/Forward);
 * hold: leave the URL alone while a closing animation runs.
 * Closing a screen goes back in history when the previous entry is exactly its parent,
 * so the browser Back button and the in-app Back button behave the same.
 */
export function useUrlSync(path: string, apply: (path: string) => void, hold = false) {
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const pathRef = useRef(path);
  pathRef.current = path;
  const ready = useRef(false);

  useEffect(() => {
    const onPop = () => {
      backPending = false;
      applyRef.current(location.pathname);
    };
    window.addEventListener('popstate', onPop);
    // First load: state comes from the URL; an unresolvable URL (someone else's server etc.) is corrected.
    applyRef.current(location.pathname);
    const id = window.setTimeout(() => {
      ready.current = true;
      if (location.pathname !== pathRef.current) history.replaceState({ prev: history.state?.prev ?? null }, '', pathRef.current);
    }, 0);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.clearTimeout(id);
    };
  }, []);

  useEffect(() => {
    if (!ready.current || hold || backPending) return;
    const cur = location.pathname;
    const ret = returnNext;
    const fwd = forwardNext;
    returnNext = forwardNext = false;
    if (cur === path) return;
    // Go back in history only when a screen closes upward and the previous entry is exactly its parent;
    // a forward move to the same URL is a new entry, otherwise Back later skips past it.
    if (!fwd && history.state?.prev === path && (ret || isUp(cur, path))) {
      backPending = true;
      history.back();
      return;
    }
    history.pushState({ prev: cur }, '', path);
  }, [path, hold]);
}
