import { useEffect, type RefObject } from 'react';

/**
 * Own microphone level as the --lvl CSS variable (0..1) and the .speaking class, without React re-renders.
 * Highlight and fill come from one signal so they always agree. The track is taken after the noise gate:
 * what does not reach the call does not fill the icon.
 */
export function useMicLevel(ref: RefObject<HTMLElement>, enabled: boolean, getTrack: () => MediaStreamTrack | undefined) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reset = () => {
      el.style.setProperty('--lvl', '0');
      el.classList.remove('speaking');
    };
    reset();
    if (!enabled) return;
    let ac: AudioContext | null = null;
    let an: AnalyserNode | null = null;
    let src: MediaStreamAudioSourceNode | null = null;
    let timer = 0;
    // Only noticeable changes are written to the DOM: --lvl used to change every frame (60 times a second for the
    // whole call, even in silence) and the phone kept repainting the blurred widget.
    let shown = -1;
    let shownSpeaking = false;
    let track: MediaStreamTrack | undefined;
    let lvl = 0;
    let holdUntil = 0;
    const buf = new Float32Array(1024);
    const tick = () => {
      const now = performance.now();
      const t = getTrack();
      if (t !== track) {
        src?.disconnect();
        src = null;
        track = t;
        if (t && t.readyState === 'live') {
          ac ??= new AudioContext();
          an ??= Object.assign(ac.createAnalyser(), { fftSize: 1024 });
          src = ac.createMediaStreamSource(new MediaStream([t]));
          src.connect(an);
        }
      }
      if (!an || !src) return;
      an.getFloatTimeDomainData(buf);
      let s = 0;
      for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
      const db = 20 * Math.log10(Math.sqrt(s / buf.length) || 1e-8);
      const target = Math.max(0, Math.min(1, (db + 55) / 40)); // -55 dB is empty, -15 dB is full.
      lvl += (target - lvl) * (target > lvl ? 0.85 : 0.3); // Fast attack, slow release (50 ms step).
      if (target > 0.12) holdUntil = now + 350; // Hold the highlight between words.
      if (lvl < 0.02) lvl = 0;
      const q = Math.round(lvl * 20) / 20;
      if (q !== shown) {
        shown = q;
        el.style.setProperty('--lvl', String(q));
      }
      const sp = now < holdUntil;
      if (sp !== shownSpeaking) {
        shownSpeaking = sp;
        el.classList.toggle('speaking', sp);
      }
    };
    // 20 times a second instead of every frame: enough for the analyser and keeps frames free.
    timer = window.setInterval(tick, 50);
    return () => {
      window.clearInterval(timer);
      src?.disconnect();
      void ac?.close();
      reset();
    };
  }, [ref, enabled, getTrack]);
}
