import { getAudioPrefs } from './audioPrefs';

/** Звуки интерфейса синтезируются на лету (WebAudio) — без файлов.
 *  Мягкие «стеклянные» тоны: синус + тихий обертон, быстрая атака, плавное затухание. */
export type SoundName = 'join' | 'leave' | 'peer-join' | 'peer-leave' | 'mic-on' | 'mic-off' | 'deafen' | 'undeafen' | 'share-on' | 'share-off' | 'message' | 'mention';

type Note = { f: number; at: number; dur: number; gain?: number };

const C5 = 523.25, D5 = 587.33, E5 = 659.25, G5 = 783.99, A5 = 880, C6 = 1046.5, E4 = 329.63, A4 = 440, G4 = 392, B4 = 493.88;

const SOUNDS: Record<SoundName, Note[]> = {
  // Вход в войс — восходящая терция с октавой, выход — то же вниз
  join: [{ f: C5, at: 0, dur: 0.18 }, { f: E5, at: 0.09, dur: 0.2 }, { f: G5, at: 0.18, dur: 0.32 }],
  leave: [{ f: G5, at: 0, dur: 0.18 }, { f: E5, at: 0.09, dur: 0.2 }, { f: C5, at: 0.18, dur: 0.32 }],
  // Кто-то зашёл / вышел — короче и тише
  'peer-join': [{ f: E5, at: 0, dur: 0.14, gain: 0.6 }, { f: A5, at: 0.08, dur: 0.24, gain: 0.6 }],
  'peer-leave': [{ f: A5, at: 0, dur: 0.14, gain: 0.6 }, { f: E5, at: 0.08, dur: 0.24, gain: 0.6 }],
  // Микрофон: вверх — включён, вниз — выключен
  'mic-on': [{ f: A4, at: 0, dur: 0.09 }, { f: E5, at: 0.06, dur: 0.16 }],
  'mic-off': [{ f: E5, at: 0, dur: 0.09 }, { f: A4, at: 0.06, dur: 0.16 }],
  // Наушники: ниже и мягче, чем микрофон
  deafen: [{ f: B4, at: 0, dur: 0.1 }, { f: G4, at: 0.07, dur: 0.12 }, { f: E4, at: 0.14, dur: 0.22 }],
  undeafen: [{ f: E4, at: 0, dur: 0.1 }, { f: G4, at: 0.07, dur: 0.12 }, { f: B4, at: 0.14, dur: 0.22 }],
  // Демонстрация: светлое арпеджио
  'share-on': [{ f: D5, at: 0, dur: 0.12 }, { f: G5, at: 0.07, dur: 0.12 }, { f: C6, at: 0.14, dur: 0.3 }],
  'share-off': [{ f: C6, at: 0, dur: 0.12 }, { f: G5, at: 0.07, dur: 0.12 }, { f: D5, at: 0.14, dur: 0.3 }],
  // Новое сообщение — короткий мягкий «дзынь»; упоминание — то же, но с третьей, верхней нотой
  message: [{ f: G5, at: 0, dur: 0.12, gain: 0.55 }, { f: C6, at: 0.07, dur: 0.26, gain: 0.5 }],
  mention: [{ f: E5, at: 0, dur: 0.1, gain: 0.6 }, { f: G5, at: 0.06, dur: 0.12, gain: 0.6 }, { f: C6, at: 0.12, dur: 0.3, gain: 0.55 }],
};

let ctx: AudioContext | null = null;
let sink = '';

function context() {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === 'suspended') void ctx.resume();
  // Звуки идут в выбранное устройство вывода (где поддерживается)
  const want = getAudioPrefs().outputId;
  const c = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
  if (want !== sink && c.setSinkId) {
    sink = want;
    c.setSinkId(want).catch(() => undefined);
  }
  return ctx;
}

export function playSound(name: SoundName, force = false) {
  const { sounds, soundVolume } = getAudioPrefs();
  if ((!sounds && !force) || soundVolume <= 0) return;
  try {
    const ac = context();
    const t0 = ac.currentTime + 0.01;
    const master = ac.createGain();
    master.gain.value = 0.22 * soundVolume;
    master.connect(ac.destination);
    for (const n of SOUNDS[name]) {
      const g = ac.createGain();
      const peak = n.gain ?? 1;
      const start = t0 + n.at;
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(peak, start + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, start + n.dur);
      g.connect(master);
      const o = ac.createOscillator();
      o.type = 'sine';
      o.frequency.value = n.f;
      o.connect(g);
      // тихий обертон октавой выше — «стеклянный» призвук
      const o2 = ac.createOscillator();
      const g2 = ac.createGain();
      o2.type = 'triangle';
      o2.frequency.value = n.f * 2;
      g2.gain.value = 0.12;
      o2.connect(g2).connect(g);
      o.start(start);
      o2.start(start);
      o.stop(start + n.dur + 0.05);
      o2.stop(start + n.dur + 0.05);
    }
    window.setTimeout(() => master.disconnect(), 1500);
  } catch {
    /* WebAudio недоступен */
  }
}
