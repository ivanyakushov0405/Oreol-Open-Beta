import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../../shared/icons';
import type { Attachment } from '../../shared/model';

/* ---------- Раскладка коллажа ----------
 * Фото идут строками; в строке все одной высоты, а ширины — по пропорциям, так что строка
 * ровно заполняет ширину коллажа. Перебираем все способы разбить фото на строки (их ≤ 2⁹ для 10 фото)
 * и берём тот, где высоты строк ближе к «удобной», а весь коллаж не слишком вытянут по высоте.
 * Крайние пропорции поджимаем — такие фото в коллаже обрезаются (object-fit: cover). */
const MIN_AR = 0.5;
const MAX_AR = 2.4;
const clampAr = (a: Attachment) => Math.min(MAX_AR, Math.max(MIN_AR, a.w / Math.max(1, a.h)));

export function collageRows(ratios: number[]): number[][] {
  const n = ratios.length;
  if (n <= 1) return n ? [[0]] : [];
  const maxPerRow = n <= 4 ? n : 4;
  const target = n <= 2 ? 0.62 : 0.42; // удобная высота строки — доля ширины коллажа
  const maxTotal = n <= 4 ? 1.25 : 1.45; // коллаж не выше, чем ~1.3 ширины
  let best: number[][] = [];
  let bestCost = Infinity;
  for (let mask = 0; mask < 1 << (n - 1); mask++) {
    // бит i — разрыв строки после фото i
    const rows: number[][] = [[0]];
    for (let i = 1; i < n; i++) {
      if (mask & (1 << (i - 1))) rows.push([i]);
      else rows[rows.length - 1].push(i);
    }
    if (rows.some((r) => r.length > maxPerRow)) continue;
    let cost = 0;
    let total = 0;
    rows.forEach((r, idx) => {
      const h = 1 / r.reduce((s, i) => s + ratios[i], 0);
      total += h;
      cost += Math.log(h / target) ** 2;
      if (h < 0.2) cost += 4; // слишком узкая полоска
      // Сверху крупнее: строка с меньшим числом фото раньше — чуть выгоднее
      if (idx > 0 && r.length < rows[idx - 1].length) cost += 0.05;
    });
    if (total > maxTotal) cost += (total - maxTotal) * 8;
    if (cost < bestCost) {
      bestCost = cost;
      best = rows;
    }
  }
  return best;
}

const singleAr = (a: Attachment) => Math.min(2.5, Math.max(0.4, a.w / Math.max(1, a.h)));

/** Ширина блока фото, px: облачко сообщения подстраивается под неё (подпись переносится по ширине фото).
 * Одно фото — не выше 380px и не шире 400px (и не шире самого фото, но не уже 200px), коллаж — 400px.
 * На узком экране облачко сжимается, а фото — вместе с ним. */
export function photosWidth(photos: Attachment[]) {
  if (photos.length !== 1) return 400;
  const a = photos[0];
  return Math.max(200, Math.min(400, Math.round(380 * singleAr(a)), a.w));
}

/** Фото в сообщении: одно — по своим пропорциям, несколько — коллажем. */
export function PhotoGrid({ photos, onOpen }: { photos: Attachment[]; onOpen?: (index: number) => void }) {
  if (!photos.length) return null;
  const tile = (a: Attachment, i: number, style: React.CSSProperties) => (
    <button
      type="button"
      key={a.id}
      className="ph-tile"
      style={style}
      aria-label={photos.length > 1 ? `Фото ${i + 1} из ${photos.length}` : 'Фото'}
      onClick={(e) => {
        // в режиме выделения нажатие отмечает сообщение — событие уходит дальше
        if (!onOpen) return;
        e.stopPropagation();
        onOpen(i);
      }}
    >
      <img src={a.url} alt="" loading="lazy" decoding="async" draggable={false} />
    </button>
  );
  if (photos.length === 1) {
    const a = photos[0];
    return <div className="photos one">{tile(a, 0, { aspectRatio: String(singleAr(a)) })}</div>;
  }
  const ratios = photos.map(clampAr);
  const rows = collageRows(ratios);
  return (
    <div className="photos">
      {rows.map((r) => (
        <div className="ph-row" key={r[0]}>
          {r.map((i) => tile(photos[i], i, { flexGrow: ratios[i], aspectRatio: String(ratios[i]) }))}
        </div>
      ))}
    </div>
  );
}

/** Просмотр фото на весь экран. Листание: свайп (пальцем или мышью — фото едет за ним, соседнее выезжает
 * следом), стрелки на экране и клавиатуре. Закрыть: свайп вниз/вверх, Esc, тап по фону, крестик. */
export function PhotoViewer({ photos, start, onClose }: { photos: Attachment[]; start: number; onClose: () => void }) {
  const [i, setI] = useState(start);
  const n = photos.length;
  const root = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; t: number; axis: 'x' | 'y' | null; dx: number; dy: number } | null>(null);
  /** Идёт анимация листания — новые жесты и кнопки ждут её конца. */
  const busy = useRef(false);
  /** После перетаскивания отпускание не считается тапом по фону. */
  const swallowClick = useRef(false);

  const setTrack = (x: number, y: number, ms = 0) => {
    const el = track.current;
    if (!el) return;
    el.style.transition = ms ? `transform ${ms}ms cubic-bezier(.2, .8, .2, 1)` : 'none';
    el.style.transform = x || y ? `translate3d(${x}px, ${y}px, 0)` : '';
    // при свайпе вниз фон светлеет — видно, что просмотр сейчас закроется
    const r = root.current;
    if (!r) return;
    r.style.setProperty('--phv-dim', String(1 - Math.min(0.6, Math.abs(y) / 500)));
    if (ms) r.style.setProperty('--phv-dim-ms', `${ms}ms`);
    else r.style.removeProperty('--phv-dim-ms');
  };
  /** Доехать до соседнего фото (d = ±1) с того места, где лента сейчас, и подменить текущее. */
  const finishSlide = (d: number, ms: number) => {
    const w = root.current?.clientWidth ?? window.innerWidth;
    busy.current = true;
    setTrack(-d * w, 0, ms);
    window.setTimeout(() => {
      setI((x) => (x + d + n) % n);
      setTrack(0, 0);
      busy.current = false;
    }, ms);
  };
  const slide = (d: number) => {
    if (n < 2 || busy.current) return;
    finishSlide(d, 240);
  };
  const slideRef = useRef(slide);
  slideRef.current = slide;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') slideRef.current(-1);
      else if (e.key === 'ArrowRight') slideRef.current(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const onPointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    if (busy.current || drag.current || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if ((e.target as HTMLElement).closest('button, a')) return;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp, axis: null, dx: 0, dy: 0 };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const s = drag.current;
    if (!s || e.pointerId !== s.id) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (!s.axis) {
      if (Math.hypot(dx, dy) < 8) return;
      s.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      try {
        root.current?.setPointerCapture(e.pointerId);
      } catch {
        /* указатель уже отпущен */
      }
    }
    if (s.axis === 'x') {
      // одно фото — только слегка поддаётся пальцу
      s.dx = n > 1 ? dx : dx * 0.25;
      setTrack(s.dx, 0);
    } else {
      s.dy = dy;
      setTrack(0, dy);
    }
  };
  const onPointerEnd = (e: React.PointerEvent, cancelled = false) => {
    const s = drag.current;
    if (!s || e.pointerId !== s.id) return;
    drag.current = null;
    if (!s.axis) return;
    swallowClick.current = true;
    window.setTimeout(() => (swallowClick.current = false), 0);
    const dt = Math.max(1, e.timeStamp - s.t);
    const w = root.current?.clientWidth ?? window.innerWidth;
    if (s.axis === 'x') {
      const fast = Math.abs(s.dx / dt) > 0.5 && Math.abs(s.dx) > 30;
      if (!cancelled && n > 1 && (Math.abs(s.dx) > w * 0.2 || fast)) finishSlide(s.dx < 0 ? 1 : -1, 220);
      else setTrack(0, 0, 220);
    } else {
      const fast = Math.abs(s.dy / dt) > 0.6 && Math.abs(s.dy) > 40;
      if (!cancelled && (Math.abs(s.dy) > 120 || fast)) onClose();
      else setTrack(0, 0, 220);
    }
  };

  const a = photos[i];
  // Лента из трёх слотов: предыдущее, текущее, следующее
  const slots = n > 1 ? [-1, 0, 1] : [0];
  return createPortal(
    <div
      ref={root}
      className="ph-viewer"
      role="dialog"
      aria-modal="true"
      aria-label="Просмотр фото"
      onClick={(e) => {
        if (swallowClick.current) return;
        // тап по фону закрывает, по самому фото и кнопкам — нет
        if (!(e.target as HTMLElement).closest('.phv-img, .phv-top, .phv-nav')) onClose();
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => onPointerEnd(e)}
      onPointerCancel={(e) => onPointerEnd(e, true)}
    >
      <div className="phv-top">
        <span className="phv-count">{n > 1 ? `${i + 1} из ${n}` : ''}</span>
        <a className="icon-btn" href={a.url} target="_blank" rel="noreferrer" title="Открыть оригинал">
          <Icon name="expand" />
        </a>
        <button type="button" className="icon-btn" title="Закрыть" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <div className="phv-track" ref={track}>
        {slots.map((k) => {
          const p = photos[(i + k + n) % n];
          return (
            <div className="phv-slide" key={k} style={{ left: `${k * 100}%` }} aria-hidden={k !== 0 || undefined}>
              <img className="phv-img" src={p.url} alt="" draggable={false} />
            </div>
          );
        })}
      </div>
      {n > 1 && (
        <>
          <button type="button" className="phv-nav prev" title="Предыдущее" onClick={() => slide(-1)}>
            <Icon name="chevron-right" className="flip" size={28} />
          </button>
          <button type="button" className="phv-nav next" title="Следующее" onClick={() => slide(1)}>
            <Icon name="chevron-right" size={28} />
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}
