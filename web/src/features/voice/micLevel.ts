import { useEffect, type RefObject } from 'react';

/** Уровень своего микрофона → CSS-переменная --lvl (0…1) и класс .speaking на кнопке; без перерисовок React.
 *  Подсветка и заполнение берутся из одного сигнала, поэтому всегда совпадают: раньше подсветка шла
 *  от детектора речи LiveKit, а заполнение — от анализатора, и они расходились.
 *  Дорожка — уже после шумового порога: что не уходит в звонок, то и не заполняет иконку. */
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
    // что уже записано в DOM — пишем только заметные изменения: раньше --lvl менялся на каждом кадре
    // (60 раз в секунду всё время звонка, даже в тишине), и телефон перерисовывал виджет с размытием без остановки
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
      const target = Math.max(0, Math.min(1, (db + 55) / 40)); // −55 дБ — пусто, −15 дБ — полная
      lvl += (target - lvl) * (target > lvl ? 0.85 : 0.3); // быстро вверх, плавно вниз (шаг 50 мс)
      if (target > 0.12) holdUntil = now + 350; // держим подсветку между словами
      if (lvl < 0.02) lvl = 0;
      const q = Math.round(lvl * 20) / 20; // 5% шаг — глазу хватает, а записей в разы меньше
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
    // 20 раз в секунду вместо каждого кадра: анализатору хватает, а кадр не занят без нужды
    timer = window.setInterval(tick, 50);
    return () => {
      window.clearInterval(timer);
      src?.disconnect();
      void ac?.close();
      reset();
    };
  }, [ref, enabled, getTrack]);
}
