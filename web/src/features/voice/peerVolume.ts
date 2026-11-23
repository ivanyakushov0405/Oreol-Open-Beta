/**
 * Per-peer volume (0..2, default 1 = 100%), like "user volume" in the context menu. Stored on the device
 * and multiplied by the output volume.
 */
const LS = 'oreol.peerVolume';
let map: Record<string, number> = {};
try {
  map = JSON.parse(localStorage.getItem(LS) || '{}') || {};
} catch {
  map = {};
}
const subs = new Set<() => void>();

export function getPeerVolume(name: string | undefined) {
  if (!name) return 1;
  const v = map[name];
  return typeof v === 'number' && v >= 0 && v <= 2 ? v : 1;
}

export function setPeerVolume(name: string, v: number) {
  const next = Math.max(0, Math.min(2, v));
  if (next === 1) delete map[name];
  else map[name] = next;
  try {
    localStorage.setItem(LS, JSON.stringify(map));
  } catch {
    /* storage unavailable: the volume lasts until reload */
  }
  subs.forEach((f) => f());
}

export function subscribePeerVolume(f: () => void) {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
}
