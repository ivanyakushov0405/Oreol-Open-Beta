import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useUser } from '../api';
import { avatarGradient, initials, type Status } from '../model';

/** Диаметр точки статуса из компонента Avatar в Figma: XS22/S28→8, M34→10, L38→11, XL48→13, 2XL80→22. */
function dotStyle(size: number): CSSProperties {
  if (size === 72) return { width: 19.5, height: 19.5, borderWidth: 3, right: 0, bottom: 0 };
  const d = size <= 28 ? 8 : size <= 34 ? 10 : size <= 38 ? 11 : size <= 48 ? 13 : Math.round(size * 0.275);
  return { width: d + 4, height: d + 4, borderWidth: 2, right: -2, bottom: -2 };
}

export function Avatar({
  name,
  size = 34,
  status,
  speaking,
}: {
  name: string;
  size?: number;
  status?: Status;
  speaking?: boolean;
}) {
  // Загруженный аватар из профиля; без него — инициалы на градиенте
  const img = useUser(name)?.avatar;
  // Точка статуса «перещёлкивается» только при смене статуса, не при первом показе
  // (класс остаётся после первой смены; точка пересоздаётся по key только при новом статусе, так что повторные рендеры анимацию не запускают)
  const prevStatus = useRef(status);
  const statusChanged = useRef(false);
  if (prevStatus.current !== status) {
    statusChanged.current = true;
    prevStatus.current = status;
  }
  return (
    <span
      className={'avatar' + (speaking ? ' speaking' : '') + (img ? ' has-img' : '')}
      style={{
        width: size,
        height: size,
        background: img ? `center / cover no-repeat url("${img}")` : avatarGradient(name),
        fontSize: Math.round(size * 0.38),
      }}
      aria-hidden="true"
    >
      {!img && initials(name)}
      {status && <i key={status} className={`status-dot status-${status}` + (statusChanged.current ? ' dot-pop' : '')} style={dotStyle(size)} />}
    </span>
  );
}

/** Фон профиля: загруженная картинка; без неё — пусто. */
export function Banner({ name, ...rest }: { name: string } & React.HTMLAttributes<HTMLDivElement>) {
  const img = useUser(name)?.banner;
  return <div className={'banner' + (img ? ' has-img' : '')} style={img ? { backgroundImage: `url("${img}")` } : undefined} {...rest} />;
}

/** Средний цвет картинки (по уменьшенной копии); null — пока не посчитан или картинки нет. */
const tintCache = new Map<string, string>();
export function useImageTint(url?: string | null) {
  const [tint, setTint] = useState<string | null>(() => (url ? tintCache.get(url) ?? null : null));
  useEffect(() => {
    if (!url) return setTint(null);
    const hit = tintCache.get(url);
    if (hit) return setTint(hit);
    let alive = true;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 16;
        const g = c.getContext('2d', { willReadFrequently: true });
        if (!g) return;
        // Средний цвет верхней части — она примыкает к заливке над фоном
        g.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight * 0.5, 0, 0, 16, 16);
        const d = g.getImageData(0, 0, 16, 16).data;
        let r = 0, gr = 0, b = 0;
        for (let i = 0; i < d.length; i += 4) { r += d[i]; gr += d[i + 1]; b += d[i + 2]; }
        const n = d.length / 4;
        const v = `rgb(${Math.round(r / n)}, ${Math.round(gr / n)}, ${Math.round(b / n)})`;
        tintCache.set(url, v);
        if (alive) setTint(v);
      } catch {
        /* чужой домен без CORS — останется градиент по умолчанию */
      }
    };
    img.src = url;
    return () => {
      alive = false;
    };
  }, [url]);
  return tint;
}

/** Заливка над фоном профиля (под строкой состояния и виджетом звонка):
 *  у своей картинки — градиент из её среднего цвета, у фона по умолчанию — тот же градиент бренда. */
export function BannerTop({ name }: { name: string }) {
  const img = useUser(name)?.banner;
  const tint = useImageTint(img);
  return (
    <div
      className="banner-top"
      style={tint ? { background: `linear-gradient(to bottom, color-mix(in srgb, ${tint} 62%, #000), ${tint})` } : undefined}
    />
  );
}
