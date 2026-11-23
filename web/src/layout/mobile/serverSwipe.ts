import { useEffect, useRef, type RefObject } from 'react';

/** Вертикальный свайп по панели каналов — соседний сервер (как в списке серверов слева: вверх — следующий, вниз — предыдущий).
 *  Пальцем — только когда список каналов упёрся в край (иначе это обычная прокрутка); решение принимаем на первом же
 *  движении: потом Safari уже забирает жест себе. Мышью — перетаскиванием панели (колесо по-прежнему прокручивает список).
 *  Панель едет за пальцем; при отпускании дальше порога — go(dir), и панель уезжает с того места, где её отпустили
 *  (саму смену с анимацией делает Mobile). */
export function useServerSwipe(stage: RefObject<HTMLElement>, opts: { can: (dir: -1 | 1) => boolean; go: (dir: -1 | 1) => void }) {
  const o = useRef(opts);
  o.current = opts;
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    type S = { panel: HTMLElement; y: number; x: number; t: number; top: boolean; bottom: boolean; dir: -1 | 1 | 0; decided: boolean; dy: number; mouse: boolean };
    let s: S | null = null;
    let swallow = false;
    const set = (panel: HTMLElement, dy: number, tr = 'none') => {
      panel.style.transition = tr;
      panel.style.transform = dy ? `translateY(${dy}px)` : '';
      panel.style.opacity = dy ? String(Math.max(0.4, 1 - Math.abs(dy) / 360)) : '';
    };
    const begin = (target: EventTarget | null, x: number, y: number, t: number, mouse: boolean) => {
      const p = (target as HTMLElement | null)?.closest<HTMLElement>('.m-servers .sidebar');
      if (!p) return void (s = null);
      const sc = p.querySelector<HTMLElement>('.sidebar-scroll');
      const top = !sc || sc.scrollTop <= 0;
      const bottom = !sc || sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 1;
      s = { panel: p, y, x, t, top, bottom, dir: 0, decided: false, dy: 0, mouse };
    };
    /** false — жест не наш (отдаём прокрутке). */
    const step = (x: number, y: number) => {
      if (!s) return false;
      const dy = y - s.y;
      const dx = x - s.x;
      if (!s.decided) {
        if (Math.abs(dy) < (s.mouse ? 6 : 8) && Math.abs(dx) < 8) return false;
        s.decided = true;
        // палец вниз — предыдущий сервер, вверх — следующий
        const dir: -1 | 1 = dy > 0 ? -1 : 1;
        const edge = s.mouse || (dir === -1 ? s.top : s.bottom);
        if (Math.abs(dy) <= Math.abs(dx) * 1.5 || !edge || !o.current.can(dir)) return void (s = null), false;
        s.dir = dir;
        window.getSelection()?.removeAllRanges();
      }
      if (!s.dir) return false;
      // за пальцем с сопротивлением; в обратную сторону почти не тянется
      const along = s.dir === -1 ? Math.max(0, dy) : Math.min(0, dy);
      s.dy = along * 0.55;
      set(s.panel, s.dy);
      return true;
    };
    const finish = (t: number) => {
      const cur = s;
      s = null;
      if (!cur || !cur.dir) return;
      swallow = true;
      window.setTimeout(() => (swallow = false), 0);
      const v = Math.abs(cur.dy) / Math.max(1, t - cur.t);
      if (Math.abs(cur.dy) > 40 || (v > 0.35 && Math.abs(cur.dy) > 14)) o.current.go(cur.dir as -1 | 1);
      else set(cur.panel, 0, 'transform .28s cubic-bezier(.2, .8, .2, 1), opacity .28s ease');
    };

    const tstart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return void (s = null);
      const t = e.touches[0];
      begin(e.target, t.clientX, t.clientY, e.timeStamp, false);
    };
    const tmove = (e: TouchEvent) => {
      if (!s || s.mouse || e.touches.length !== 1) return;
      const t = e.touches[0];
      if (step(t.clientX, t.clientY) && e.cancelable) e.preventDefault();
    };
    const tend = (e: TouchEvent) => s && !s.mouse && finish(e.timeStamp);
    const pdown = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      begin(e.target, e.clientX, e.clientY, e.timeStamp, true);
    };
    const pmove = (e: PointerEvent) => {
      if (!s || !s.mouse) return;
      if (step(e.clientX, e.clientY)) e.preventDefault();
    };
    const pup = (e: PointerEvent) => s && s.mouse && finish(e.timeStamp);
    // после перетаскивания мышью отпускание не открывает канал под курсором
    const click = (e: MouseEvent) => {
      if (!swallow) return;
      e.preventDefault();
      e.stopPropagation();
    };
    el.addEventListener('touchstart', tstart, { passive: true });
    el.addEventListener('touchmove', tmove, { passive: false });
    el.addEventListener('touchend', tend);
    el.addEventListener('touchcancel', tend);
    el.addEventListener('pointerdown', pdown);
    window.addEventListener('pointermove', pmove);
    window.addEventListener('pointerup', pup);
    el.addEventListener('click', click, true);
    return () => {
      el.removeEventListener('touchstart', tstart);
      el.removeEventListener('touchmove', tmove);
      el.removeEventListener('touchend', tend);
      el.removeEventListener('touchcancel', tend);
      el.removeEventListener('pointerdown', pdown);
      window.removeEventListener('pointermove', pmove);
      window.removeEventListener('pointerup', pup);
      el.removeEventListener('click', click, true);
    };
  }, [stage]);
}
