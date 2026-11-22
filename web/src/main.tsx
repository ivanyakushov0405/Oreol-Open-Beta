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

// Safari на iPhone не слушает user-scalable=no — щипок для масштаба запрещаем его собственными событиями жестов.
// Страница стоит «крепко»: не приближается, не плавает и не мешает свайпам.
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}

// Приложение с главного экрана — только вертикально (в обычной вкладке браузер блокировать поворот не даёт;
// там при повороте остаётся мобильная версия, см. useIsMobile)
(screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> } | undefined)?.lock?.('portrait').catch(() => undefined);

// Телефон набок — своя раскладка (html[data-land] в styles.css): таб-панель ниже, поля под вырез экрана, плитки в ряд
{
  const mq = matchMedia('(pointer: coarse) and (orientation: landscape) and (max-height: 520px)');
  const sync = () => {
    if (mq.matches) document.documentElement.dataset.land = '';
    else delete document.documentElement.dataset.land;
  };
  sync();
  mq.addEventListener('change', sync);
}

// Пока интерфейс поднимается, анимации выключены (класс снимает Shell после первой отрисовки)
document.documentElement.classList.add('boot');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
