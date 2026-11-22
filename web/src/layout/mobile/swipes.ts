import { useEffect, useRef, type RefObject } from 'react';

/** Жесты телефона на сцене:
 *  — свайп вправо по верхнему экрану (чат, войс, участники, настройки) — экран едет за пальцем и закрывается, как «Назад»;
 *  — горизонтальный свайп по основному экрану (не по таб-панели) — соседняя вкладка.
 *  Вертикальная прокрутка не мешает: жест начинается, только когда палец ушёл вбок заметно сильнее, чем вверх-вниз. */
interface Opts {
  /** Нижний экран нужен во время свайпа назад (обычно он скрыт под верхним). */
  onPeek: (on: boolean) => void;
  /** -1 — вкладка слева, 1 — справа. false — туда некуда. */
  canTab: (dir: -1 | 1) => boolean;
  onTab: (dir: -1 | 1) => void;
}

const START = 10;
/** Что проявляется под верхним экраном при свайпе назад. Прозрачность ставим прямо этим элементам:
 *  CSS-переменная на сцене (как было) на каждом движении пальца заставляла Safari пересчитывать стили всего приложения. */
const UNDER =
  ':scope > .m-under.dim, :scope > .m-under.dim:not(.tabbar) > :not(.m-servers-row), :scope > .m-under.dim .m-servers-row > *, ' +
  ':scope > .m-settings:has(~ .m-settings.m-slide:not(.out)) > :not(.m-head)';
/** Панели экрана вкладки, которые чуть гаснут при свайпе по вкладкам. */
const PANELS = ':scope > :not(.m-servers-row), :scope > .m-servers-row > *';
const fade = (list: Iterable<HTMLElement>, v: number | null) => {
  for (const n of list) {
    if (v === null) n.style.removeProperty('opacity');
    else n.style.setProperty('opacity', String(v), 'important');
  }
};
const SKIP = 'input, textarea, select, [contenteditable], .tabbar, .m-call, .m-call-pill, .member-card, .popover-backdrop, .msg-menu, .m-menu, .dialog';

export function useStageSwipes(stage: RefObject<HTMLElement>, opts: Opts) {
  const o = useRef(opts);
  o.current = opts;
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    type S = { id: number; x: number; y: number; t: number; kind: 'back' | 'tab'; node: HTMLElement; active: boolean; dx: number };
    let s: S | null = null;
    let swallowClick = false;

    const topSlide = () => {
      // войс, открытый из виджета поверх других экранов, стоит в разметке раньше них, но он верхний
      const over = el.querySelector<HTMLElement>(':scope > .m-slide.m-over:not(.out)');
      if (over) return over;
      const list = el.querySelectorAll<HTMLElement>(':scope > .m-slide:not(.out)');
      return list[list.length - 1] ?? null;
    };

    const down = (e: PointerEvent) => {
      if (e.button !== 0 || s) return;
      const t = e.target as HTMLElement;
      if (t.closest(SKIP)) return;
      const slide = topSlide();
      if (slide) {
        if (!slide.contains(t)) return;
        s = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp, kind: 'back', node: slide, active: false, dx: 0 };
        return;
      }
      const screen = t.closest<HTMLElement>('.m-stage > .m-under:not(.tabbar)');
      if (!screen || screen.parentElement !== el) return;
      s = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp, kind: 'tab', node: screen, active: false, dx: 0 };
    };

    const move = (e: PointerEvent) => {
      if (!s || e.pointerId !== s.id) return;
      const dx = e.clientX - s.x;
      const dy = e.clientY - s.y;
      if (!s.active) {
        if (Math.abs(dy) > START && Math.abs(dy) >= Math.abs(dx)) return void (s = null);
        if (Math.abs(dx) < START || Math.abs(dx) < Math.abs(dy) * 1.5) return;
        if (s.kind === 'back' && dx < 0) return void (s = null);
        s.active = true;
        window.getSelection()?.removeAllRanges();
        // начало жеста отсчитываем отсюда — без рывка на первые пиксели
        s.x = e.clientX - Math.sign(dx);
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          /* указатель уже отпущен */
        }
        if (s.kind === 'back') {
          o.current.onPeek(true);
          el.dataset.swipe = 'back';
          s.node.dataset.swiping = '';
        } else {
          el.dataset.swipe = 'tab';
        }
      }
      e.preventDefault();
      const w = el.clientWidth || 1;
      let x = e.clientX - s.x;
      if (s.kind === 'back') {
        x = Math.max(0, x);
        s.node.style.transform = `translateX(${x}px)`;
        // шапка не едет с экраном — стоит на месте, как при обычном «Назад»
        const head = s.node.querySelector<HTMLElement>(':scope > .m-head');
        if (head) head.style.transform = `translateX(${-x}px)`;
        fade(el.querySelectorAll<HTMLElement>(UNDER), Math.min(1, x / w));
      } else {
        // к краю (вкладки дальше нет) — тянется с сопротивлением
        // экран не «летает» — лишь чуть поддаётся пальцу и гаснет, к краю (вкладки дальше нет) ещё слабее
        const k = o.current.canTab(x < 0 ? 1 : -1) ? 0.12 : 0.05;
        s.node.style.transform = `translateX(${x * k}px)`;
        // гаснут сами панели: opacity на экране целиком отрезала бы стеклу фон
        fade(s.node.querySelectorAll<HTMLElement>(PANELS), 1 - Math.min(0.35, (Math.abs(x) / w) * 0.5));
      }
      s.dx = x;
    };

    const finish = (e: PointerEvent, cancelled: boolean) => {
      if (!s || e.pointerId !== s.id) return;
      const cur = s;
      s = null;
      if (!cur.active) return;
      const swallow = () => {
        swallowClick = true;
        window.setTimeout(() => (swallowClick = false), 0);
      };
      const w = el.clientWidth || 1;
      const v = cur.dx / Math.max(1, e.timeStamp - cur.t);
      const n = cur.node;
      if (cur.kind === 'back') {
        const head = n.querySelector<HTMLElement>(':scope > .m-head');
        delete el.dataset.swipe;
        delete n.dataset.swiping;
        const go = !cancelled && (cur.dx > w * 0.35 || (v > 0.45 && cur.dx > 40));
        if (go) {
          // уезжает дальше с того места, где его отпустили (см. @keyframes m-slide-out)
          n.style.setProperty('--swipe-x', `${cur.dx}px`);
          n.style.transform = '';
          if (head) head.style.transform = '';
          n.querySelector<HTMLButtonElement>(':scope > .m-head .pill-btn')?.click();
          swallow();
          fade(el.querySelectorAll<HTMLElement>(UNDER), null);
          window.setTimeout(() => o.current.onPeek(false), 400);
        } else {
          n.style.transition = 'transform .26s cubic-bezier(.2, .8, .2, 1)';
          n.style.transform = 'translateX(0)';
          if (head) {
            head.style.transition = n.style.transition;
            head.style.transform = 'translateX(0)';
          }
          swallow();
          el.dataset.swipe = 'cancel';
          const under = [...el.querySelectorAll<HTMLElement>(UNDER)];
          fade(under, 0);
          window.setTimeout(() => {
            fade(under, null);
            n.style.transition = '';
            n.style.transform = '';
            if (head) head.style.transition = head.style.transform = '';
            delete el.dataset.swipe;
            o.current.onPeek(false);
          }, 260);
        }
        return;
      }
      delete el.dataset.swipe;
      swallow();
      const dir: -1 | 1 = cur.dx < 0 ? 1 : -1;
      const go = !cancelled && o.current.canTab(dir) && (Math.abs(cur.dx) > w * 0.25 || (Math.abs(v) > 0.45 && Math.abs(cur.dx) > 40));
      if (go) {
        // новая вкладка сама проявляется из размытия (см. Mobile: pickTab)
        n.style.transition = n.style.transform = '';
        fade(n.querySelectorAll<HTMLElement>(PANELS), null);
        o.current.onTab(dir);
      } else {
        n.style.transition = 'transform .26s cubic-bezier(.2, .8, .2, 1)';
        n.style.transform = '';
        fade(n.querySelectorAll<HTMLElement>(PANELS), null);
        window.setTimeout(() => (n.style.transition = ''), 260);
      }
    };

    const up = (e: PointerEvent) => finish(e, false);
    const cancel = (e: PointerEvent) => finish(e, true);
    // после жеста отпускание пальца не должно нажимать то, что под ним (канал, сообщение)
    const click = (e: MouseEvent) => {
      if (!swallowClick) return;
      e.preventDefault();
      e.stopPropagation();
    };

    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move, { passive: false });
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', cancel);
    el.addEventListener('click', click, true);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', cancel);
      el.removeEventListener('click', click, true);
    };
  }, [stage]);
}
