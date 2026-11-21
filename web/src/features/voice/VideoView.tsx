import { useEffect, useRef } from 'react';
import type { Track } from 'livekit-client';

export function VideoView({ track, mirror, contain }: { track: Track; mirror?: boolean; contain?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);
  return <video ref={ref} autoPlay playsInline muted className={(mirror ? 'mirror ' : '') + (contain ? 'contain' : '')} />;
}
