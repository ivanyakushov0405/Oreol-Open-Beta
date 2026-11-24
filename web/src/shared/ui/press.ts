/**
 * Elastic press for the back button: it swells and settles on every tap, however short. Uses the `scale` property,
 * so the header's own transform animations (the swipe bump, the chat menu morph) play on top of it.
 */
const SPRING: Keyframe[] = [
  { scale: '1' },
  { scale: '1.16', offset: 0.32 },
  { scale: '0.96', offset: 0.68 },
  { scale: '1' },
];

export function springPress(el: Element) {
  el.animate(SPRING, { duration: 440, easing: 'cubic-bezier(.3, .7, .4, 1)' });
}
