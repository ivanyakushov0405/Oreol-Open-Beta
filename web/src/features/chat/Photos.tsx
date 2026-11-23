import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../../shared/icons';
import { fileSize, type Attachment } from '../../shared/model';
import { t } from '../../shared/i18n';

/*
  Collage layout: photos go in rows of equal height with widths by aspect ratio, so each row fills the width.
  All ways to break photos into rows are tried (at most 2^9 for 10 photos), picking the one whose row heights
  are closest to the preferred one without making the collage too tall. Extreme ratios are clamped and cropped.
*/
const MIN_AR = 0.5;
const MAX_AR = 2.4;
const clampAr = (a: Attachment) => Math.min(MAX_AR, Math.max(MIN_AR, a.w / Math.max(1, a.h)));

export function collageRows(ratios: number[]): number[][] {
  const n = ratios.length;
  if (n <= 1) return n ? [[0]] : [];
  const maxPerRow = n <= 4 ? n : 4;
  const target = n <= 2 ? 0.62 : 0.42;
  const maxTotal = n <= 4 ? 1.25 : 1.45;
  let best: number[][] = [];
  let bestCost = Infinity;
  for (let mask = 0; mask < 1 << (n - 1); mask++) {
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
      if (h < 0.2) cost += 4;
      // Bigger on top: a row with fewer photos earlier is slightly preferred.
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

/** Documents in a message: name, size and a download link. */
export function FileList({ files, selecting }: { files: Attachment[]; selecting: boolean }) {
  return (
    <div className="msg-files">
      {files.map((f) => (
        <a
          key={f.id}
          className="msg-file"
          href={f.url}
          download={f.name || true}
          draggable={false}
          onClick={(e) => (selecting ? e.preventDefault() : e.stopPropagation())}
        >
          <span className="mf-icon">
            <Icon name="file" size={20} />
          </span>
          <span className="mf-body">
            <span className="mf-name">{f.name || t('Файл')}</span>
            <span className="mf-size">{fileSize(f.size)}</span>
          </span>
          <Icon name="download" size={18} className="mf-dl" />
        </a>
      ))}
    </div>
  );
}

export function photosWidth(photos: Attachment[]) {
  if (photos.length !== 1) return 400;
  const a = photos[0];
  return Math.max(200, Math.min(400, Math.round(380 * singleAr(a)), a.w));
}

export function PhotoGrid({ photos, onOpen }: { photos: Attachment[]; onOpen?: (index: number) => void }) {
  if (!photos.length) return null;
  const tile = (a: Attachment, i: number, style: React.CSSProperties) => (
    <button
      type="button"
      key={a.id}
      style={style}
      className={'ph-tile' + (a.video ? ' is-video' : '')}
      aria-label={(a.video ? t('Видео') : t('Фото')) + (photos.length > 1 ? t(' {0} из {1}', { 0: i + 1, 1: photos.length }) : '')}
      onClick={(e) => {
        if (!onOpen) return;
        e.stopPropagation();
        onOpen(i);
      }}
    >
      {a.video ? (
        <>
          {/* #t makes Safari show the first frame instead of a black box. */}
          <video src={a.url + '#t=0.1'} muted playsInline preload="metadata" tabIndex={-1} />
          <span className="ph-play">
            <Icon name="play" size={22} />
          </span>
        </>
      ) : (
        <img src={a.url} alt="" loading="lazy" decoding="async" draggable={false} />
      )}
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

export const touchDevice = () => matchMedia('(hover: none) and (pointer: coarse)').matches;
const fileName = (url: string, type: string) => {
  const base = decodeURIComponent(url.split('?')[0].split('/').pop() || 'photo');
  const ext = type.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
  return /\.[a-z0-9]{2,5}$/i.test(base) ? base : `${base}.${ext}`;
};
/**
 * Photos fetched in advance: share on phones only works right on the tap; awaiting a download first makes Safari
 * consider the user gesture over and the sheet does not open.
 */
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
/** Browsers only accept PNG in the clipboard; everything else is redrawn. */
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
        const h = await picker({ suggestedName: name, types: [{ description: blob.type.startsWith('video/') ? t('Видео') : t('Изображение'), accept: { [blob.type || 'image/jpeg']: ['.' + name.split('.').pop()] } }] });
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
    // A promise inside ClipboardItem keeps Safari's user gesture alive while the photo loads.
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': photoBlob(url).then(toPng) })]);
    return true;
  } catch {
    return false;
  }
}

export function PhotoViewer({ photos, start, onClose }: { photos: Attachment[]; start: number; onClose: () => void }) {
  const [i, setI] = useState(start);
  const n = photos.length;
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
    if (touch && !photos[i].video) prefetchPhoto(photos[i].url);
  }, [touch, photos, i]);
  const root = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; t: number; axis: 'x' | 'y' | null; dx: number; dy: number } | null>(null);
  const busy = useRef(false);
  const swallowClick = useRef(false);

  const setTrack = (x: number, y: number, ms = 0) => {
    const el = track.current;
    if (!el) return;
    el.style.transition = ms ? `transform ${ms}ms cubic-bezier(.2, .8, .2, 1)` : 'none';
    el.style.transform = x || y ? `translate3d(${x}px, ${y}px, 0)` : '';
    const r = root.current;
    if (!r) return;
    r.style.setProperty('--phv-dim', String(1 - Math.min(0.6, Math.abs(y) / 500)));
    if (ms) r.style.setProperty('--phv-dim-ms', `${ms}ms`);
    else r.style.removeProperty('--phv-dim-ms');
  };
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
    // On a video the finger controls the player (seek, volume); swiping only works outside it.
    if ((e.target as HTMLElement).closest('video') && e.pointerType === 'mouse') return;
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
        /* ignore */
      }
    }
    if (s.axis === 'x') {
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
  const slots = n > 1 ? [-1, 0, 1] : [0];
  return createPortal(
    <div
      ref={root}
      className="ph-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={t('Просмотр вложений')}
      onClick={(e) => {
        if (swallowClick.current) return;
        if (more) return setMore(false);
        if (!(e.target as HTMLElement).closest('.phv-img, .phv-top, .phv-nav, .phv-menu')) onClose();
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => onPointerEnd(e)}
      onPointerCancel={(e) => onPointerEnd(e, true)}
    >
      <div className="phv-top">
        <span className="phv-count">{n > 1 ? t('{0} из {1}', { 0: i + 1, 1: n }) : ''}</span>
        {touch ? (
          <button
            type="button"
            className="icon-btn"
            title={t('Сохранить')}
            onClick={() => void savePhoto(a.url, false).then((r) => r === 'fail' && say(t('Не удалось сохранить'), false))}
          >
            <Icon name="download" />
          </button>
        ) : (
          <>
            <a className="icon-btn" href={a.url} target="_blank" rel="noreferrer" title={t('Открыть оригинал')}>
              <Icon name="expand" />
            </a>
            <button type="button" className={'icon-btn' + (more ? ' active' : '')} title={t('Ещё')} aria-expanded={more} onClick={() => setMore((v) => !v)}>
              <Icon name="more" />
            </button>
          </>
        )}
        <button type="button" className="icon-btn" title={t('Закрыть')} onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      {more && (
        <div className="phv-menu msg-menu" role="menu">
          {!a.video && <button
            type="button"
            role="menuitem"
            className="msg-menu-item"
            onClick={() => {
              setMore(false);
              void copyPhoto(a.url).then((ok) => say(ok ? t('Изображение скопировано') : t('Не удалось скопировать'), ok));
            }}
          >
            <Icon name="copy" size={18} />
            <span>{t('Копировать изображение')}</span>
          </button>}
          <button
            type="button"
            role="menuitem"
            className="msg-menu-item"
            onClick={() => {
              setMore(false);
              void savePhoto(a.url, true).then((r) => r === 'fail' && say(t('Не удалось сохранить'), false));
            }}
          >
            <Icon name="download" size={18} />
            <span>{t('Сохранить как…')}</span>
          </button>
        </div>
      )}
      {note && <div className={'phv-note' + (note.ok ? '' : ' err')}>{note.text}</div>}
      <div className="phv-track" ref={track}>
        {slots.map((k) => {
          const p = photos[(i + k + n) % n];
          return (
            <div className="phv-slide" key={k} style={{ left: `${k * 100}%` }} aria-hidden={k !== 0 || undefined}>
              {p.video ? (
                k === 0 ? (
                  <video className="phv-img phv-video" src={p.url} controls autoPlay playsInline />
                ) : (
                  <video className="phv-img phv-video" src={p.url + '#t=0.1'} muted playsInline preload="metadata" />
                )
              ) : (
                <img className="phv-img" src={p.url} alt="" draggable={false} />
              )}
            </div>
          );
        })}
      </div>
      {n > 1 && (
        <>
          <button type="button" className="phv-nav prev" title={t('Предыдущее')} onClick={() => slide(-1)}>
            <Icon name="chevron-right" className="flip" size={28} />
          </button>
          <button type="button" className="phv-nav next" title={t('Следующее')} onClick={() => slide(1)}>
            <Icon name="chevron-right" size={28} />
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}
