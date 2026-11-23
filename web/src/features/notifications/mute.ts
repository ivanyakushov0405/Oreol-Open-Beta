import { useSyncExternalStore } from 'react';

const LS_MUTED = 'oreol.muted';
const listeners = new Set<() => void>();

function read(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(LS_MUTED) || '[]');
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}
let muted = read();

export const isMuted = (room: string) => muted.has(room);

export function setMuted(room: string, on: boolean) {
  muted = new Set(muted);
  if (on) muted.add(room);
  else muted.delete(room);
  try {
    localStorage.setItem(LS_MUTED, JSON.stringify([...muted]));
  } catch {
    /* storage blocked */
  }
  listeners.forEach((f) => f());
}

const subscribe = (f: () => void) => {
  listeners.add(f);
  return () => listeners.delete(f);
};

/** Muted rooms skip sounds and pop-ups for ordinary messages; mentions still come through. */
export function useMuted(room: string | null | undefined) {
  return useSyncExternalStore(subscribe, () => !!room && muted.has(room));
}
