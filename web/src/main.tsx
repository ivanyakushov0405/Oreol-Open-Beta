import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './app/styles.css';
import App from './app/App';

// Полоса прокрутки видна только во время прокрутки и пропадает через ~1 с после неё.
const hideTimers = new WeakMap<Element, number>();
document.addEventListener(
  'scroll',
  (e) => {
    const el = e.target instanceof Element ? e.target : document.scrollingElement;
    if (!el) return;
    el.classList.add('is-scrolling');
    window.clearTimeout(hideTimers.get(el));
    hideTimers.set(el, window.setTimeout(() => el.classList.remove('is-scrolling'), 2000));
  },
  { capture: true, passive: true },
);

// Пока интерфейс поднимается, анимации выключены (класс снимает Shell после первой отрисовки)
document.documentElement.classList.add('boot');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
