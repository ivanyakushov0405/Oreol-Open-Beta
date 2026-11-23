import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { SLIDE_IN_MS } from './Mobile';

export function useSettled(flag: boolean) {
  const [settled, setSettled] = useState(flag);
  useEffect(() => {
    if (!flag) {
      setSettled(false);
      return;
    }
    const id = window.setTimeout(() => setSettled(true), SLIDE_IN_MS);
    return () => window.clearTimeout(id);
  }, [flag]);
  return settled;
}

/** Shade under the tab bar (::after on .m-stage) with a hole under the bar itself, so the bar's glass is not darkened. */
export function useTabShadeClip(stage: React.RefObject<HTMLDivElement>) {
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const update = () => {
      const tb = el.querySelector<HTMLElement>(':scope > .tabbar');
      const after = getComputedStyle(el, '::after');
      const H = parseFloat(after.height) || 0;
      if (!tb || !H || after.content === 'none') return el.style.removeProperty('--tab-clip');
      const s = el.getBoundingClientRect();
      const r = tb.getBoundingClientRect();
      const W = s.width;
      const x = r.left - s.left;
      const y = r.top - (s.bottom - H);
      const w = r.width;
      const h = r.height;
      const rad = Math.min(parseFloat(getComputedStyle(tb).borderTopLeftRadius) || 0, w / 2, h / 2);
      const d =
        `M0 0H${W}V${H}H0Z` +
        `M${x + rad} ${y}H${x + w - rad}A${rad} ${rad} 0 0 1 ${x + w} ${y + rad}V${y + h - rad}A${rad} ${rad} 0 0 1 ${x + w - rad} ${y + h}` +
        `H${x + rad}A${rad} ${rad} 0 0 1 ${x} ${y + h - rad}V${y + rad}A${rad} ${rad} 0 0 1 ${x + rad} ${y}Z`;
      el.style.setProperty('--tab-clip', `path(evenodd, '${d}')`);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    const watch = () => {
      const tb = el.querySelector(':scope > .tabbar');
      if (tb) ro.observe(tb);
      update();
    };
    const mo = new MutationObserver(watch);
    mo.observe(el, { childList: true });
    watch();
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * Tab highlight is a springy bubble: it moves to the selected tab on a spring, stretches along the motion,
 * swells on press, and can be grabbed and dragged; released, it snaps to the nearest tab.
 */
export function useJellyTabs(
  nav: React.RefObject<HTMLElement>,
  glider: React.RefObject<HTMLElement>,
  index: number,
  count: number,
  onPick: (i: number) => void,
) {
  const st = useRef({ x: 0, v: 0, target: 0, p: 0, pv: 0, pTarget: 0, drag: false, finger: 0, grab: 0, raf: 0, last: 0, ready: false, startX: 0, id: -1, moved: false, eat: false });
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
  const width = () => (nav.current ? nav.current.clientWidth / count : 0);

  const paint = () => {
    const g = glider.current;
    if (!g) return;
    const s = st.current;
    const k = Math.max(-1, Math.min(1, s.v / 2600));
    const sx = 1 + Math.abs(k) * 0.32 + s.p * 0.1;
    const sy = 1 - Math.abs(k) * 0.2 + s.p * 0.06;
    const w = width();
    const ext = (w * (sx - 1)) / 2;
    const x = Math.min(w * (count - 1) - ext, Math.max(ext, s.x));
    g.style.transform = `translateX(${x}px) scale(${sx}, ${sy})`;
    const tabs = nav.current?.querySelectorAll<HTMLElement>(':scope > .tab');
    if (tabs) {
      const peek = s.drag && w ? Math.max(0, Math.min(count - 1, Math.round(x / w))) : -1;
      tabs.forEach((t, i) => {
        if (i === peek) t.dataset.peek = '';
        else delete t.dataset.peek;
      });
    }
  };
  const tick = (t: number) => {
    const s = st.current;
    const dt = Math.min(0.032, s.last ? (t - s.last) / 1000 : 0.016);
    s.last = t;
    const w = width();
    const max = w * (count - 1);
    if (s.drag) {
      const want = s.finger - s.grab - w / 2;
      s.target = Math.max(0, Math.min(max, want));
    }
    const kx = s.drag ? 900 : 380;
    const cx = s.drag ? 52 : 24;
    s.v += (kx * (s.target - s.x) - cx * s.v) * dt;
    s.x += s.v * dt;
    s.pv += (520 * (s.pTarget - s.p) - 18 * s.pv) * dt;
    s.p += s.pv * dt;
    paint();
    const still = Math.abs(s.target - s.x) < 0.3 && Math.abs(s.v) < 4 && Math.abs(s.pTarget - s.p) < 0.002 && Math.abs(s.pv) < 0.01;
    if (still && !s.drag) {
      s.x = s.target;
      s.v = 0;
      s.p = s.pTarget;
      s.pv = 0;
      s.raf = 0;
      s.last = 0;
      paint();
      return;
    }
    s.raf = requestAnimationFrame(tick);
  };
  const kick = () => {
    if (!st.current.raf) st.current.raf = requestAnimationFrame(tick);
  };

  // The tab bar disappears while a screen is open on top and comes back after Back:
  // put the new bubble on the current tab right away and attach handlers to the new bar.
  const [navEl, setNavEl] = useState<HTMLElement | null>(null);
  const lastGlider = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (nav.current !== navEl) setNavEl(nav.current);
    const g = glider.current;
    if (g === lastGlider.current) return;
    lastGlider.current = g;
    const s = st.current;
    if (!g || !s.ready) return;
    s.target = s.x = index * width();
    s.v = 0;
    paint();
  });

  useLayoutEffect(() => {
    const s = st.current;
    s.target = index * width();
    if (!s.ready) {
      s.ready = true;
      s.x = s.target;
      paint();
      return;
    }
    kick();
  }, [index]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = navEl;
    if (!el) return;
    const s = st.current;
    const ro = new ResizeObserver(() => {
      if (s.drag) return;
      s.target = s.x = index * width();
      paint();
    });
    ro.observe(el);
    const local = (e: PointerEvent) => e.clientX - el.getBoundingClientRect().left;
    const down = (e: PointerEvent) => {
      if (e.button !== 0 || s.id !== -1) return;
      s.id = e.pointerId;
      s.startX = e.clientX;
      s.moved = false;
      s.finger = local(e);
      const w = width();
      // Grabbing the bubble itself keeps the grab point; otherwise the bubble moves under the finger.
      const onBubble = s.finger >= s.x && s.finger <= s.x + w;
      s.grab = onBubble ? s.finger - (s.x + w / 2) : 0;
      s.pTarget = onBubble ? 1 : 0.45;
      kick();
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== s.id) return;
      s.finger = local(e);
      if (!s.moved && Math.abs(e.clientX - s.startX) > 6) {
        s.moved = true;
        s.drag = true;
        s.pTarget = 1;
        el.dataset.drag = '';
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      }
      if (s.drag) kick();
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== s.id) return;
      s.id = -1;
      s.pTarget = 0;
      if (s.drag) {
        s.drag = false;
        delete el.dataset.drag;
        paint();
        s.eat = true; // The click after a drag must not select the tab under the finger.
        const w = width();
        // Drop position: under the finger plus a little inertia.
        const flick = s.finger - s.grab - w / 2 + s.v * 0.08;
        const i = Math.max(0, Math.min(count - 1, Math.round(flick / w)));
        s.target = i * w;
        if (i !== index) pickRef.current(i);
      }
      kick();
    };
    const click = (e: MouseEvent) => {
      if (s.eat) {
        s.eat = false;
        e.stopPropagation();
        e.preventDefault();
      }
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('click', click, true);
    return () => {
      ro.disconnect();
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('click', click, true);
    };
  }, [index, count, navEl]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => cancelAnimationFrame(st.current.raf), []);
}
