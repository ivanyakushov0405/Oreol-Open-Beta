import { useEffect, useState } from 'react';
import { api } from '../../shared/api';

interface Preview {
  url: string;
  title: string;
  description: string;
  image: string | null;
  site: string;
  gif?: boolean;
  w?: number | null;
  h?: number | null;
}

const cache = new Map<string, Promise<Preview | null>>();
function load(url: string) {
  let p = cache.get(url);
  if (!p) {
    p = api<Preview>(`/api/link-preview?url=${encodeURIComponent(url)}`).catch(() => null);
    cache.set(url, p);
  }
  return p;
}

export function LinkPreview({ url }: { url: string }) {
  const [data, setData] = useState<Preview | null>(null);
  const [imgOk, setImgOk] = useState(true);
  useEffect(() => {
    let alive = true;
    void load(url).then((d) => alive && setData(d));
    return () => {
      alive = false;
    };
  }, [url]);
  if (!data) return null;
  if (data.gif && data.image) {
    if (!imgOk) return null;
    return (
      <a className="link-gif" href={url} target="_blank" rel="noopener noreferrer nofollow" onClick={(e) => e.stopPropagation()} draggable={false}>
        <img
          src={data.image}
          alt={data.title}
          width={data.w ?? undefined}
          height={data.h ?? undefined}
          decoding="async"
          referrerPolicy="no-referrer"
          draggable={false}
          onError={() => setImgOk(false)}
        />
      </a>
    );
  }
  return (
    <a
      className="link-card"
      href={url}
      target="_blank"
      rel="noopener noreferrer nofollow"
      onClick={(e) => e.stopPropagation()}
      draggable={false}
    >
      <span className="lc-site">{data.site}</span>
      <span className="lc-title">{data.title}</span>
      {data.description && <span className="lc-desc">{data.description}</span>}
      {data.image && imgOk && (
        <img
          className="lc-img"
          src={data.image}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          draggable={false}
          onError={() => setImgOk(false)}
        />
      )}
    </a>
  );
}
