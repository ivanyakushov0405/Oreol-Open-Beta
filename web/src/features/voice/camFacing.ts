import { useSyncExternalStore } from 'react';

/** Какая камера телефона снимает: фронтальная (user) или основная (environment).
 *  Общий маленький стор: кнопка на своей плитке переключает, useVoice перезапускает дорожку,
 *  плитка решает, зеркалить ли видео (основную камеру не зеркалят). */
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
/** Попросить useVoice сменить камеру. */
export const requestFlip = () => window.dispatchEvent(new Event(FLIP_EVENT));
