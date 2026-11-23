import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useUser } from '../api';
import { avatarGradient, initials, type Status } from '../model';

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
  const img = useUser(name)?.avatar;
  // The status dot pops only when the status changes, not on first show
  // (the class stays after the first change; the dot is re-keyed only on a new status, so re-renders do not replay it).
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

export function Banner({ name, ...rest }: { name: string } & React.HTMLAttributes<HTMLDivElement>) {
  const img = useUser(name)?.banner;
  return <div className={'banner' + (img ? ' has-img' : '')} style={img ? { backgroundImage: `url("${img}")` } : undefined} {...rest} />;
}

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
        // Average color of the top part, which borders the fill above the banner.
        g.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight * 0.5, 0, 0, 16, 16);
        const d = g.getImageData(0, 0, 16, 16).data;
        let r = 0, gr = 0, b = 0;
        for (let i = 0; i < d.length; i += 4) { r += d[i]; gr += d[i + 1]; b += d[i + 2]; }
        const n = d.length / 4;
        const v = `rgb(${Math.round(r / n)}, ${Math.round(gr / n)}, ${Math.round(b / n)})`;
        tintCache.set(url, v);
        if (alive) setTint(v);
      } catch {
        /* cross-origin image without CORS: the default gradient stays */
      }
    };
    img.src = url;
    return () => {
      alive = false;
    };
  }, [url]);
  return tint;
}

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
