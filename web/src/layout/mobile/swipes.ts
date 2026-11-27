import { useEffect, useRef, type RefObject } from 'react';

/**
 * Phone gestures on the stage:
 * - swipe right on an upper screen (chat, voice, members, settings): the screen follows the finger and closes like Back;
 * - horizontal swipe on the main screen (not on the tab bar): neighbouring tab.
 * Vertical scrolling is unaffected: a gesture starts only when the finger moves sideways clearly more than vertically.
 */
interface Opts {
  onPeek: (on: boolean) => void;
  canTab: (dir: -1 | 1) => boolean;
  onTab: (dir: -1 | 1) => void;
}

const START = 10;
/**
 * What appears under the upper screen during a back swipe. Opacity is set on these elements directly: a CSS variable
 * on the stage made Safari restyle the whole app on every finger move.
 */
const UNDER =
  ':scope > .m-under.dim, :scope > .m-under.dim:not(.tabbar) > :not(.m-servers-row), :scope > .m-under.dim .m-servers-row > :not(.srv-stack), :scope > .m-under.dim .m-servers-row > .srv-stack > .sidebar, ' +
  ':scope > .m-settings:has(~ .m-settings.m-slide:not(.out)) > :not(.m-head)';
const PANELS = ':scope > :not(.m-servers-row), :scope > .m-servers-row > :not(.srv-stack), :scope > .m-servers-row > .srv-stack > .sidebar';
const fade = (list: Iterable<HTMLElement>, v: number | null) => {
  for (const n of list) {
    if (v === null) n.style.removeProperty('opacity');
    else n.style.setProperty('opacity', String(v), 'important');
  }
};
/**
 * Settings cards under a settings screen are glass: they are shown or cut at an edge (viewport px) instead of fading,
 * since Safari draws glass with opacity below 1 untinted. Only the cards themselves are cut: a cut on
 * a box around glass would grey that glass too. dx is how far an element will still move before tr ends; edge null
 * releases them. Rects are read before any write.
 */
const wipe = (list: Iterable<HTMLElement>, edge: number | null, tr?: string, dx = 0) => {
  const els = [...list];
  if (edge === null) {
    for (const n of els) (n.style.removeProperty('clip-path'), n.style.removeProperty('transition'));
    return;
  }
  const right = els.map((n) => Math.max(-40, n.getBoundingClientRect().right + dx - edge));
  els.forEach((n, i) => {
    if (tr) n.style.setProperty('transition', tr, 'important');
    n.style.setProperty('clip-path', `inset(-40px ${right[i].toFixed(1)}px -40px -40px)`, 'important');
  });
};
const UNDER_BOX = ':scope > .m-under.dim:not(.tabbar)';
const shift = (list: Iterable<HTMLElement>, v: string | null, tr = 'none') => {
  for (const n of list) {
    if (v === null) (n.style.removeProperty('transform'), n.style.removeProperty('transition'));
    else (n.style.setProperty('transform', v, 'important'), n.style.setProperty('transition', tr, 'important'));
  }
};
const SKIP = 'input, textarea, select, [contenteditable], .ci-full:not([data-edge]), .tabbar, .m-call, .m-call-pill, .member-card, .popover-backdrop, .msg-menu, .m-menu, .dialog';

export function useStageSwipes(stage: RefObject<HTMLElement>, opts: Opts) {
  const o = useRef(opts);
  o.current = opts;
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    type S = { id: number; x: number; y: number; t: number; kind: 'back' | 'tab'; node: HTMLElement; active: boolean; dx: number };
    let s: S | null = null;
    let swallowClick = false;
    /** Frost over the lower screen during a back swipe: right under the upper one, at its level, clearing as it moves. */
    let veil: HTMLElement | null = null;
    const veilOn = (node: HTMLElement) => {
      veil?.remove();
      veil = document.createElement('div');
      veil.className = 'm-swipe-veil';
      veil.style.zIndex = getComputedStyle(node).zIndex;
      node.before(veil);
    };
    const veilSet = (p: number, w: number, tr?: string) => {
      if (!veil) return;
      if (tr) veil.style.transition = tr;
      veil.style.opacity = String(1 - p);
      // Only the strip the upper screen has left: under it the screen frosts by itself.
      veil.style.clipPath = `inset(0 ${(w * (1 - p)).toFixed(1)}px 0 0)`;
    };
    const veilOff = () => {
      veil?.remove();
      veil = null;
      for (const n of el.querySelectorAll<HTMLElement>(':scope > [data-frost]')) delete n.dataset.frost;
    };

    /**
     * What appears under the leaving screen. With stacked screens (Settings > Blocked) only the previous screen shows;
     * the tab below is hidden (it showed through the settings glass as a shifted mess).
     */
    const underEls = (): HTMLElement[] => {
      // The upper screen is not necessarily last in the markup (voice over other screens comes before them), so take "all but the upper one".
      const top = topSlide();
      const rest = [...el.querySelectorAll<HTMLElement>(':scope > .m-slide:not(.out)')].filter((n) => n !== top);
      if (rest.length) return [];
      return [...el.querySelectorAll<HTMLElement>(UNDER)];
    };
    /** The screen right under the upper one, when screens are stacked. */
    const slideUnder = () => {
      const top = topSlide();
      const rest = [...el.querySelectorAll<HTMLElement>(':scope > .m-slide:not(.out)')].filter((n) => n !== top);
      return rest[rest.length - 1] ?? null;
    };
    /** Cards of the settings screen right under the upper one (see wipe). */
    const cardsUnder = (): HTMLElement[] => {
      const under = slideUnder();
      return under?.matches('.m-settings') ? [...under.querySelectorAll<HTMLElement>(':scope > :not(.m-head) > *')] : [];
    };
    /**
     * Content of another screen right under the upper one (the chat under its info screen). It stays visible under a
     * covering screen, so it is only faded, never cut: a cut on a box around glass would grey that glass.
     */
    const bodyUnder = (): HTMLElement[] => {
      const under = slideUnder();
      return under && !under.matches('.m-settings') ? [...under.querySelectorAll<HTMLElement>(':scope > :not(.m-head)')] : [];
    };
    /**
     * The lower screen that follows the finger, only when the tab screen sits right under the upper screen. With stacked
     * screens (Settings > Voice) the tab below must not move: it showed through the settings shifted.
     */
    const boxesUnder = () =>
      el.querySelectorAll(':scope > .m-slide:not(.out)').length > 1 ? [] : [...el.querySelectorAll<HTMLElement>(UNDER_BOX)];
    /** Release everything the gesture held manually (if it broke off and neither up nor cancel ever came). */
    const resetAll = () => {
      for (const n of el.querySelectorAll<HTMLElement>(':scope > .m-slide, :scope > .m-slide > .m-head, :scope > .m-under')) {
        n.style.removeProperty('transform');
        n.style.removeProperty('transition');
        delete n.dataset.swiping;
      }
      fade(el.querySelectorAll<HTMLElement>(UNDER), null);
      for (const u of el.querySelectorAll<HTMLElement>(UNDER)) u.style.removeProperty('transition');
      for (const n of el.querySelectorAll<HTMLElement>(':scope > .m-under')) fade(n.querySelectorAll<HTMLElement>(PANELS), null);
      wipe(el.querySelectorAll<HTMLElement>(':scope > .m-settings > :not(.m-head) > *'), null);
      fade(el.querySelectorAll<HTMLElement>(':scope > .m-settings > :not(.m-head) > *'), null);
      for (const b of el.querySelectorAll<HTMLElement>(':scope > .m-slide:not(.m-settings) > :not(.m-head)')) {
        b.style.removeProperty('opacity');
        b.style.removeProperty('transition');
      }
      for (const u of el.querySelectorAll<HTMLElement>(UNDER)) u.style.removeProperty('transition');
      delete el.dataset.swipe;
      delete el.dataset.swiped;
      veilOff();
    };
    const topSlide = () => {
      // Voice opened from the widget over other screens comes earlier in the markup but is on top.
      const over = el.querySelector<HTMLElement>(':scope > .m-slide.m-over:not(.out)');
      if (over) return over;
      const list = el.querySelectorAll<HTMLElement>(':scope > .m-slide:not(.out)');
      return list[list.length - 1] ?? null;
    };

    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      if (s) {
        // The previous gesture never finished (iOS sometimes sends neither pointerup nor pointercancel);
        // this used to stop swipes from working entirely and left screens shifted.
        if (s.id === e.pointerId) return;
        const was = s;
        s = null;
        if (was.active) {
          resetAll();
          o.current.onPeek(false);
        }
      }
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
        // The finger moves in an arc: count the swipe as soon as horizontal travel exceeds vertical.
        if (Math.abs(dy) > START && Math.abs(dy) > Math.abs(dx)) return void (s = null);
        if (Math.abs(dx) < START || Math.abs(dx) <= Math.abs(dy)) return;
        if (s.kind === 'back' && dx < 0) return void (s = null);
        s.active = true;
        window.getSelection()?.removeAllRanges();
        // Measure the gesture from here, so the first pixels do not jump.
        s.x = e.clientX - Math.sign(dx);
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
        if (s.kind === 'back') {
          o.current.onPeek(true);
          el.dataset.swipe = 'back';
          s.node.dataset.swiping = '';
          // The screen's own frost blurs only during the gesture and its ending: a constant blur slowed theme changes.
          s.node.dataset.frost = '';
          veilOn(s.node);
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
        const head = s.node.querySelector<HTMLElement>(':scope > .m-head');
        if (head) head.style.transform = `translateX(${-x}px)`;
        const p = Math.min(1, x / w);
        const under = underEls();
        fade(under, p);
        veilSet(p, w);
        // The lower screen follows the finger (as in iOS) instead of sitting shifted.
        shift(boxesUnder(), `translateX(${(-22 * (1 - p)).toFixed(2)}%)`);
        // The upper screen frosts what lies under it, so the cards show whole and blurred, as under the chat.
        const cards = cardsUnder();
        wipe(cards, Infinity);
        // Faded like any lower screen, or their sharp text shows through the clearing frost. Under the frost Safari's
        // grey glass at opacity below 1 does not show.
        fade(cards, p);
        fade(bodyUnder(), p);
      } else {
        const k = o.current.canTab(x < 0 ? 1 : -1) ? 0.12 : 0.05;
        s.node.style.transform = `translateX(${x * k}px)`;
        // Fade the panels themselves: opacity on the whole screen would cut the glass off from its backdrop.
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
        // The screen is long open: dropping "animation: none" with the gesture must not replay its entry animation.
        n.dataset.settled = '';
        delete el.dataset.swipe;
        delete n.dataset.swiping;
        const go = !cancelled && (cur.dx > w * 0.35 || (v > 0.45 && cur.dx > 40));
        if (go) {
          // Slides further from where it was released (see @keyframes m-slide-out).
          n.style.setProperty('--swipe-x', `${cur.dx}px`);
          n.style.transform = '';
          if (head) head.style.transform = '';
          // The lower screen is almost visible: finish smoothly without its own "return" animation;
          // resetting opacity used to make everything under the screen flash.
          const under = underEls();
          const cards = cardsUnder();
          const boxes = boxesUnder();
          el.dataset.swiped = '';
          // Everything clears on the curve of the screen sliding out, otherwise the lower screen turns sharp before it leaves.
          for (const u of under) u.style.setProperty('transition', 'opacity .22s cubic-bezier(.4, 0, .7, .2)', 'important');
          fade(under, 1);
          veilSet(1, w, 'opacity .22s cubic-bezier(.4, 0, .7, .2), clip-path .22s cubic-bezier(.4, 0, .7, .2)');
          const body = bodyUnder();
          wipe(cards, Infinity, 'clip-path .22s cubic-bezier(.4, 0, .7, .2), opacity .22s cubic-bezier(.4, 0, .7, .2)');
          fade(cards, 1);
          for (const b of body) b.style.setProperty('transition', 'opacity .22s cubic-bezier(.4, 0, .7, .2)', 'important');
          fade(body, 1);
          shift(boxes, 'none', 'transform .22s cubic-bezier(.4, 0, .7, .2)');
          n.querySelector<HTMLButtonElement>(':scope > .m-head .pill-btn')?.click();
          swallow();
          window.setTimeout(() => {
            o.current.onPeek(false);
            window.setTimeout(() => {
              fade(under, null);
              for (const u of under) u.style.removeProperty('transition');
              wipe(cards, null);
              fade(cards, null);
              fade(body, null);
              for (const b of body) b.style.removeProperty('transition');
              shift(boxes, null);
              veilOff();
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
          const under = underEls();
          const cards = cardsUnder();
          const boxes = boxesUnder();
          fade(under, 0);
          veilSet(0, w, 'opacity .26s ease, clip-path .26s cubic-bezier(.2, .8, .2, 1)');
          // The cards are covered and blurred by now: a short fade does not show Safari's grey glass.
          for (const c of cards) c.style.setProperty('transition', 'opacity .26s ease', 'important');
          fade(cards, 0);
          // The content under a covering screen stays visible, so it returns to full instead of fading out.
          const body = bodyUnder();
          for (const b of body) b.style.setProperty('transition', 'opacity .26s ease', 'important');
          fade(body, 1);
          shift(boxes, 'translateX(-22%)', 'transform .26s cubic-bezier(.2, .8, .2, 1)');
          window.setTimeout(() => {
            fade(under, null);
            wipe(cards, null);
            fade(cards, null);
            fade(body, null);
            for (const b of body) b.style.removeProperty('transition');
            shift(boxes, null);
            veilOff();
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
    // After a gesture, lifting the finger must not tap what is under it (channel, message).
    const click = (e: MouseEvent) => {
      if (!swallowClick) return;
      e.preventDefault();
      e.stopPropagation();
    };

    // Safari decides "this is a scroll" from the first finger moves and then takes the gesture (pointercancel);
    // while the finger moves more sideways than vertically, or our swipe is running, scrolling is not handed to the browser.
    let t0: { x: number; y: number } | null = null;
    const tstart = (e: TouchEvent) => {
      const t = e.touches[0];
      t0 = e.touches.length === 1 && t ? { x: t.clientX, y: t.clientY } : null;
    };
    // Fallback end: the finger is up but pointerup/pointercancel never came, so finish the gesture ourselves.
    const tend = (e: TouchEvent) => {
      if (e.touches.length) return;
      const cur = s;
      if (!cur) return;
      const ts = e.timeStamp;
      window.setTimeout(() => {
        if (s === cur) finish({ pointerId: cur.id, timeStamp: ts } as PointerEvent, e.type === 'touchcancel');
      }, 50);
    };
    const tmove = (e: TouchEvent) => {
      if (!s || !t0 || e.touches.length !== 1) return;
      if (s.active) return void (e.cancelable && e.preventDefault());
      const t = e.touches[0];
      const dx = t.clientX - t0.x;
      const dy = t.clientY - t0.y;
      if (s.kind === 'back' && dx < 0) return;
      // Only clearly sideways: iOS remembers a cancelled first move for the whole gesture and lists stopped scrolling.
      if (Math.abs(dx) > 6 && Math.abs(dx) > Math.abs(dy) * 1.3 && e.cancelable) e.preventDefault();
    };
    el.addEventListener('touchstart', tstart, { passive: true });
    el.addEventListener('touchmove', tmove, { passive: false });
    window.addEventListener('touchend', tend, { passive: true });
    window.addEventListener('touchcancel', tend, { passive: true });
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move, { passive: false });
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', cancel);
    el.addEventListener('click', click, true);
    return () => {
      el.removeEventListener('touchstart', tstart);
      el.removeEventListener('touchmove', tmove);
      window.removeEventListener('touchend', tend);
      window.removeEventListener('touchcancel', tend);
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', cancel);
      el.removeEventListener('click', click, true);
    };
  }, [stage]);
}
