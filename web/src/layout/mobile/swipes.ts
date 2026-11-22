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
/** Нижние экраны целиком (для сдвига вслед за пальцем). */
const UNDER_BOX = ':scope > .m-under.dim:not(.tabbar)';
const shift = (list: Iterable<HTMLElement>, v: string | null, tr = 'none') => {
  for (const n of list) {
    if (v === null) (n.style.removeProperty('transform'), n.style.removeProperty('transition'));
    else (n.style.setProperty('transform', v, 'important'), n.style.setProperty('transition', tr, 'important'));
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
        // Палец ведёт дугой: свайп засчитываем, как только вбок ушло больше, чем вверх-вниз
        // (раньше требовали в 1,5 раза больше — обычный свайп большим пальцем часто не проходил)
        if (Math.abs(dy) > START && Math.abs(dy) > Math.abs(dx)) return void (s = null);
        if (Math.abs(dx) < START || Math.abs(dx) <= Math.abs(dy)) return;
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
        const p = Math.min(1, x / w);
        fade(el.querySelectorAll<HTMLElement>(UNDER), p);
        // нижний экран подъезжает вслед за пальцем (как в iOS), а не стоит сдвинутым
        shift(el.querySelectorAll<HTMLElement>(UNDER_BOX), `translateX(${(-22 * (1 - p)).toFixed(2)}%)`);
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
          // Нижний экран уже почти проявлен: доводим его до конца плавно и без своей анимации «возврата» —
          // раньше прозрачность сбрасывалась, и всё под экраном мигало (сначала гасло, потом проявлялось заново)
          const under = [...el.querySelectorAll<HTMLElement>(UNDER)];
          const boxes = [...el.querySelectorAll<HTMLElement>(UNDER_BOX)];
          el.dataset.swiped = '';
          for (const u of under) u.style.setProperty('transition', 'opacity .22s ease', 'important');
          fade(under, 1);
          shift(boxes, 'none', 'transform .22s cubic-bezier(.4, 0, .7, .2)');
          n.querySelector<HTMLButtonElement>(':scope > .m-head .pill-btn')?.click();
          swallow();
          window.setTimeout(() => {
            o.current.onPeek(false);
            // экран, уехавший вправо, уже убран — снимаем всё, что держали руками
            window.setTimeout(() => {
              fade(under, null);
              for (const u of under) u.style.removeProperty('transition');
              shift(boxes, null);
              delete el.dataset.swiped;
            }, 80);
          }, 400);
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
          const boxes = [...el.querySelectorAll<HTMLElement>(UNDER_BOX)];
          fade(under, 0);
          shift(boxes, 'translateX(-22%)', 'transform .26s cubic-bezier(.2, .8, .2, 1)');
          window.setTimeout(() => {
            fade(under, null);
            shift(boxes, null);
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

    // Safari решает «это прокрутка» по первым движениям пальца и тогда забирает жест себе (pointercancel) —
    // пока палец идёт скорее вбок, чем вверх-вниз, или наш свайп уже идёт, прокрутку браузеру не отдаём
    let t0: { x: number; y: number } | null = null;
    const tstart = (e: TouchEvent) => {
      const t = e.touches[0];
      t0 = e.touches.length === 1 && t ? { x: t.clientX, y: t.clientY } : null;
    };
    const tmove = (e: TouchEvent) => {
      if (!s || !t0 || e.touches.length !== 1) return;
      if (s.active) return void (e.cancelable && e.preventDefault());
      const t = e.touches[0];
      const dx = t.clientX - t0.x;
      const dy = t.clientY - t0.y;
      if (s.kind === 'back' && dx < 0) return;
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 3 && e.cancelable) e.preventDefault();
    };
    el.addEventListener('touchstart', tstart, { passive: true });
    el.addEventListener('touchmove', tmove, { passive: false });
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move, { passive: false });
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', cancel);
    el.addEventListener('click', click, true);
    return () => {
      el.removeEventListener('touchstart', tstart);
      el.removeEventListener('touchmove', tmove);
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', cancel);
      el.removeEventListener('click', click, true);
    };
  }, [stage]);
}
