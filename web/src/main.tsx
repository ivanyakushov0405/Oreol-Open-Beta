import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './app/styles.css';
import App from './app/App';

// The scrollbar shows only while scrolling and hides about 1 s after.
// Phones have no custom scrollbar, so the class is left alone: every class change restyled the whole screen
// and a long chat scrolled in jerks.
const hideTimers = new WeakMap<Element, number>();
const touchOnly = matchMedia('(hover: none) and (pointer: coarse)');
document.addEventListener(
  'scroll',
  (e) => {
    if (touchOnly.matches) return;
    const el = e.target instanceof Element ? e.target : document.scrollingElement;
    if (!el) return;
    // classList.add rewrites the attribute even when the class is present, which restyles again.
    if (!el.classList.contains('is-scrolling')) el.classList.add('is-scrolling');
    window.clearTimeout(hideTimers.get(el));
    hideTimers.set(el, window.setTimeout(() => el.classList.remove('is-scrolling'), 2000));
  },
  { capture: true, passive: true },
);

// Safari on iPhone ignores user-scalable=no, so pinch zoom is blocked through its own gesture events.
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}

// The home screen app is portrait only (a regular tab cannot lock rotation;
// there the mobile layout stays on rotation, see useIsMobile).
(screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> } | undefined)?.lock?.('portrait').catch(() => undefined);

// Landscape phone has its own layout (html[data-land] in styles.css).
{
  const mq = matchMedia('(pointer: coarse) and (orientation: landscape) and (max-height: 520px)');
  const sync = () => {
    if (mq.matches) document.documentElement.dataset.land = '';
    else delete document.documentElement.dataset.land;
  };
  sync();
  mq.addEventListener('change', sync);
}

// Animations stay off while the UI boots (the class is removed after the first render).
document.documentElement.classList.add('boot');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
