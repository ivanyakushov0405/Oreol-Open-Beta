import { useSyncExternalStore } from 'react';

/**
 * Which phone camera is active: front (user) or back (environment). Tiny shared store: the button on our tile
 * switches it, useVoice restarts the track, the tile decides whether to mirror (the back camera is not mirrored).
 */
export type Facing = 'user' | 'environment';
let facing: Facing = 'user';
const subs = new Set<() => void>();
export const FLIP_EVENT = 'oreol:cam-flip';

export const getFacing = () => facing;
export function setFacing(f: Facing) {
  if (f === facing) return;
  facing = f;
  subs.forEach((s) => s());
}
export function useFacing() {
  return useSyncExternalStore(
    (s) => (subs.add(s), () => subs.delete(s)),
    getFacing,
    getFacing,
  );
}
export const requestFlip = () => window.dispatchEvent(new Event(FLIP_EVENT));
