import { getAudioPrefs } from './audioPrefs';

/**
 * UI sounds are synthesized on the fly with WebAudio, no files: soft glassy tones (sine plus a quiet overtone,
 * fast attack, smooth decay).
 */
export type SoundName = 'join' | 'leave' | 'peer-join' | 'peer-leave' | 'mic-on' | 'mic-off' | 'deafen' | 'undeafen' | 'share-on' | 'share-off' | 'message' | 'mention';

type Note = { f: number; at: number; dur: number; gain?: number };

const C5 = 523.25, D5 = 587.33, E5 = 659.25, G5 = 783.99, A5 = 880, C6 = 1046.5, E4 = 329.63, A4 = 440, G4 = 392, B4 = 493.88;

const SOUNDS: Record<SoundName, Note[]> = {
  join: [{ f: C5, at: 0, dur: 0.18 }, { f: E5, at: 0.09, dur: 0.2 }, { f: G5, at: 0.18, dur: 0.32 }],
  leave: [{ f: G5, at: 0, dur: 0.18 }, { f: E5, at: 0.09, dur: 0.2 }, { f: C5, at: 0.18, dur: 0.32 }],
  'peer-join': [{ f: E5, at: 0, dur: 0.14, gain: 0.6 }, { f: A5, at: 0.08, dur: 0.24, gain: 0.6 }],
  'peer-leave': [{ f: A5, at: 0, dur: 0.14, gain: 0.6 }, { f: E5, at: 0.08, dur: 0.24, gain: 0.6 }],
  'mic-on': [{ f: A4, at: 0, dur: 0.09 }, { f: E5, at: 0.06, dur: 0.16 }],
  'mic-off': [{ f: E5, at: 0, dur: 0.09 }, { f: A4, at: 0.06, dur: 0.16 }],
  deafen: [{ f: B4, at: 0, dur: 0.1 }, { f: G4, at: 0.07, dur: 0.12 }, { f: E4, at: 0.14, dur: 0.22 }],
  undeafen: [{ f: E4, at: 0, dur: 0.1 }, { f: G4, at: 0.07, dur: 0.12 }, { f: B4, at: 0.14, dur: 0.22 }],
  'share-on': [{ f: D5, at: 0, dur: 0.12 }, { f: G5, at: 0.07, dur: 0.12 }, { f: C6, at: 0.14, dur: 0.3 }],
  'share-off': [{ f: C6, at: 0, dur: 0.12 }, { f: G5, at: 0.07, dur: 0.12 }, { f: D5, at: 0.14, dur: 0.3 }],
  message: [{ f: G5, at: 0, dur: 0.12, gain: 0.55 }, { f: C6, at: 0.07, dur: 0.26, gain: 0.5 }],
  mention: [{ f: E5, at: 0, dur: 0.1, gain: 0.6 }, { f: G5, at: 0.06, dur: 0.12, gain: 0.6 }, { f: C6, at: 0.12, dur: 0.3, gain: 0.55 }],
};

let ctx: AudioContext | null = null;
let sink = '';

/**
 * After backgrounding, a call or a lock iOS moves the context to "suspended"/"interrupted", and it can only be resumed
 * inside a touch, so it is woken on every gesture and when the tab becomes visible. A closed context (or one that
 * never woke up) is recreated; sounds used to stay silent until reload.
 */
function wake(recreate = false) {
  if (!ctx) return;
  if (ctx.state === 'closed' || (recreate && ctx.state !== 'running')) {
    void ctx.close().catch(() => undefined);
    ctx = null;
    sink = '';
    return;
  }
  if (ctx.state !== 'running') void ctx.resume().catch(() => undefined);
}
if (typeof window !== 'undefined') {
  let stuck = 0;
  const onGesture = () => {
    // The context is created inside the first gesture: one made later by an incoming message starts suspended,
    // and on phones sounds stayed silent until a voice call unlocked audio.
    if (!ctx) return unlock();
    if (ctx.state === 'running') return void (stuck = 0);
    // Two gestures in a row did not help: the context is stuck, create a new one (the next sound opens it).
    wake(++stuck > 2);
  };
  for (const ev of ['pointerdown', 'touchend', 'keydown']) window.addEventListener(ev, onGesture, { capture: true, passive: true });
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && wake());
  window.addEventListener('pageshow', () => wake());
}

/** Creates and starts the context inside a gesture; a one-sample silent buffer is what iOS counts as unlocking. */
function unlock() {
  try {
    setSession();
    const ac = context();
    const src = ac.createBufferSource();
    src.buffer = ac.createBuffer(1, 1, 22050);
    src.connect(ac.destination);
    src.start(0);
  } catch {
    /* WebAudio unavailable */
  }
}

/**
 * Safari puts WebAudio in the "ambient" session, which the silent switch mutes; a voice call switched it and sounds
 * appeared only after joining voice. "transient" is meant for short notification sounds. A session already set
 * (by a call) is left alone.
 */
function setSession() {
  const s = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
  if (s && s.type === 'auto') s.type = 'transient';
}

function context() {
  if (!ctx || ctx.state === 'closed') ctx = new AudioContext();
  if (ctx.state !== 'running') void ctx.resume().catch(() => undefined);
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
    /* WebAudio unavailable */
  }
}
