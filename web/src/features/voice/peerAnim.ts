import { useEffect, useReducer, useRef } from 'react';

/**
 * Join/leave animation for voice participants: newcomers are marked "in", leavers stay in place marked "out"
 * for ~0.25 s to fade out. scope changes (server or connection) skip the animation and show the new list.
 */
const PEER_ANIM_MS = 260;
export type Anim = 'in' | 'out' | undefined;
export function usePeerAnim<T>(items: T[], keyOf: (t: T) => string, scope: string, settleMs = 0): { item: T; key: string; anim: Anim }[] {
  const st = useRef<{ scope: string | null; at: number; prev: T[]; seen: Set<string>; fresh: Map<string, number>; ghosts: Map<string, { item: T; idx: number; at: number }> }>({
    scope: null,
    at: 0,
    prev: [],
    seen: new Set(),
    fresh: new Map(),
    ghosts: new Map(),
  });
  const [, tick] = useReducer((x: number) => x + 1, 0);
  const s = st.current;
  const now = Date.now();
  const keys = items.map(keyOf);
  const keySet = new Set(keys);
  if (s.scope !== scope) {
    s.scope = scope;
    s.at = now;
    s.seen = new Set(keys);
    s.fresh.clear();
    s.ghosts.clear();
  } else if (now - s.at < settleMs || (s.prev.length === 0 && items.length > 0)) {
    // Right after the list source changes (we joined or left ourselves) the list settles without animation;
    // same when the list arrives for the first time (server members load after the channel opens).
    // Right after the list source changes (we joined or left ourselves) the list settles without animation.
    s.seen = new Set(keys);
    s.ghosts.clear();
  } else {
    s.prev.forEach((it, i) => {
      const k = keyOf(it);
      if (!keySet.has(k) && !s.ghosts.has(k)) s.ghosts.set(k, { item: it, idx: i, at: now });
    });
    for (const k of keys) {
      if (s.ghosts.has(k)) s.ghosts.delete(k); // Came back while fading out.
      if (!s.seen.has(k)) {
        s.seen.add(k);
        s.fresh.set(k, now);
      }
    }
    for (const k of [...s.seen]) if (!keySet.has(k)) s.seen.delete(k);
  }
  s.prev = items;
  for (const [k, at] of s.fresh) if (now - at > PEER_ANIM_MS) s.fresh.delete(k);
  for (const [k, g] of s.ghosts) if (now - g.at > PEER_ANIM_MS) s.ghosts.delete(k);

  const pending = s.fresh.size + s.ghosts.size;
  useEffect(() => {
    if (!pending) return;
    const id = window.setTimeout(tick, PEER_ANIM_MS + 20);
    return () => window.clearTimeout(id);
  });

  const out: { item: T; key: string; anim: Anim }[] = items.map((item, i) => ({ item, key: keys[i], anim: s.fresh.has(keys[i]) ? 'in' : undefined }));
  [...s.ghosts.entries()]
    .sort((a, b) => a[1].idx - b[1].idx)
    .forEach(([k, g]) => out.splice(Math.min(g.idx, out.length), 0, { item: g.item, key: k, anim: 'out' }));
  return out;
}
export const animClass = (a: Anim) => (a === 'in' ? ' peer-in' : a === 'out' ? ' peer-out' : '');
