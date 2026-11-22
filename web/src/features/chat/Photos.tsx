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
/** Телефон или планшет (палец, без наведения): там у фото только «Сохранить». */
export const touchDevice = () => matchMedia('(hover: none) and (pointer: coarse)').matches;
const fileName = (url: string, type: string) => {
  const base = decodeURIComponent(url.split('?')[0].split('/').pop() || 'photo');
  const ext = type.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
  return /\.[a-z0-9]{2,5}$/i.test(base) ? base : `${base}.${ext}`;
};
/** Фото, уже скачанные заранее: «Поделиться» на телефоне работает только сразу по нажатию —
 *  если сначала ждать загрузку, Safari считает, что жест пользователя закончился, и окно не открывает. */
const ready = new Map<string, Blob>();
export function prefetchPhoto(url: string) {
  if (ready.has(url)) return;
  void photoBlob(url).then((b) => ready.set(url, b), () => undefined);
}
async function photoBlob(url: string) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('fetch');
  return r.blob();
}
/** В буфер обмена браузер берёт только PNG — остальное перерисовываем. */
async function toPng(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob;
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext('2d')!.drawImage(bmp, 0, 0);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('png'))), 'image/png'));
}
function downloadBlob(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
type SavePicker = (o: { suggestedName: string; types?: { description: string; accept: Record<string, string[]> }[] }) => Promise<{
  createWritable: () => Promise<{ write: (b: Blob) => Promise<void>; close: () => Promise<void> }>;
}>;

/** Копировать / сохранить фото. Телефон: «Сохранить» открывает системное меню «Поделиться» (там «Сохранить изображение»
 *  кладёт фото в галерею), без него — обычное скачивание. Компьютер: «Сохранить как…» — окно выбора места, где оно есть. */
export async function savePhoto(url: string, asDialog: boolean): Promise<'ok' | 'cancel' | 'fail'> {
  try {
    const blob = ready.get(url) ?? (await photoBlob(url));
    const name = fileName(url, blob.type);
    if (touchDevice()) {
      const file = new File([blob], name, { type: blob.type || 'image/jpeg' });
      if (navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ files: [file] });
          return 'ok';
        } catch (e) {
          if (e instanceof DOMException && e.name === 'AbortError') return 'cancel';
        }
      }
      downloadBlob(blob, name);
      return 'ok';
    }
    const picker = (window as Window & { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
    if (asDialog && picker) {
      try {
        const h = await picker({ suggestedName: name, types: [{ description: 'Изображение', accept: { [blob.type || 'image/jpeg']: ['.' + name.split('.').pop()] } }] });
        const w = await h.createWritable();
        await w.write(blob);
        await w.close();
        return 'ok';
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return 'cancel';
      }
    }
    downloadBlob(blob, name);
    return 'ok';
  } catch {
    return 'fail';
  }
}
export async function copyPhoto(url: string) {
  try {
    // промис в ClipboardItem — так Safari не теряет «жест пользователя», пока фото грузится
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': photoBlob(url).then(toPng) })]);
    return true;
  } catch {
    return false;
  }
}

export function PhotoViewer({ photos, start, onClose }: { photos: Attachment[]; start: number; onClose: () => void }) {
  const [i, setI] = useState(start);
  const n = photos.length;
  /** Меню «…» (компьютер) и короткая подсказка о результате. */
  const [more, setMore] = useState(false);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  const noteTimer = useRef(0);
  const say = (text: string, ok = true) => {
    setNote({ text, ok });
    window.clearTimeout(noteTimer.current);
    noteTimer.current = window.setTimeout(() => setNote(null), 1800);
  };
  useEffect(() => () => window.clearTimeout(noteTimer.current), []);
  const touch = touchDevice();
  useEffect(() => {
    if (touch) prefetchPhoto(photos[i].url);
  }, [touch, photos, i]);
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
        if (more) return setMore(false);
        if (!(e.target as HTMLElement).closest('.phv-img, .phv-top, .phv-nav, .phv-menu')) onClose();
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => onPointerEnd(e)}
      onPointerCancel={(e) => onPointerEnd(e, true)}
    >
      <div className="phv-top">
        <span className="phv-count">{n > 1 ? `${i + 1} из ${n}` : ''}</span>
        {touch ? (
          <button
            type="button"
            className="icon-btn"
            title="Сохранить"
            onClick={() => void savePhoto(a.url, false).then((r) => r === 'fail' && say('Не удалось сохранить', false))}
          >
            <Icon name="download" />
          </button>
        ) : (
          <>
            <a className="icon-btn" href={a.url} target="_blank" rel="noreferrer" title="Открыть оригинал">
              <Icon name="expand" />
            </a>
            <button type="button" className={'icon-btn' + (more ? ' active' : '')} title="Ещё" aria-expanded={more} onClick={() => setMore((v) => !v)}>
              <Icon name="more" />
            </button>
          </>
        )}
        <button type="button" className="icon-btn" title="Закрыть" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      {more && (
        <div className="phv-menu msg-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className="msg-menu-item"
            onClick={() => {
              setMore(false);
              void copyPhoto(a.url).then((ok) => say(ok ? 'Изображение скопировано' : 'Не удалось скопировать', ok));
            }}
          >
            <Icon name="copy" size={18} />
            <span>Копировать изображение</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="msg-menu-item"
            onClick={() => {
              setMore(false);
              void savePhoto(a.url, true).then((r) => r === 'fail' && say('Не удалось сохранить', false));
            }}
          >
            <Icon name="download" size={18} />
            <span>Сохранить как…</span>
          </button>
        </div>
      )}
      {note && <div className={'phv-note' + (note.ok ? '' : ' err')}>{note.text}</div>}
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
