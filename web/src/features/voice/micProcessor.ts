import type { AudioProcessorOptions, Track, TrackProcessor } from 'livekit-client';
import { getAudioPrefs, subscribeAudioPrefs } from '../../shared/audio/audioPrefs';

/** Обработка микрофона перед отправкой: громкость ввода и шумовой порог (чувствительность).
 *  микрофон → AudioWorklet «oreol-gate» (усиление + ворота) → в звонок.
 *
 *  Ворота работают в аудиопотоке, а не на таймере страницы: раньше порог проверялся раз в 20 мс
 *  через setInterval, и при любой нагрузке на страницу (а в фоновой вкладке — раз в секунду)
 *  ворота не успевали открыться — голос получался прерывистым. */
const GATE_SRC = `
class OreolGate extends AudioWorkletProcessor {
  constructor() {
    super();
    this.vol = 1; this.auto = true; this.thr = -50;
    this.pow = 0; this.g = 1; this.holdUntil = 0;
    this.port.onmessage = (e) => { const d = e.data; this.vol = d.vol; this.auto = d.auto; this.thr = d.thr; };
  }
  process(inputs, outputs) {
    const inp = inputs[0] && inputs[0][0];
    const out = outputs[0];
    if (!out || !out[0]) return true;
    if (!inp) { for (const ch of out) ch.fill(0); return true; }
    const n = inp.length, vol = this.vol;
    let s = 0;
    for (let i = 0; i < n; i++) { const x = inp[i] * vol; s += x * x; }
    // сглаженная мощность (~25 мс), как у индикатора уровня в настройках
    this.pow += (s / n - this.pow) * Math.min(1, n / (0.025 * sampleRate));
    const db = 10 * Math.log10(this.pow || 1e-10);
    // после слова держим открытыми 400 мс, чтобы не «рубить» окончания и паузы между словами
    if (this.auto || db > this.thr) this.holdUntil = currentTime + 0.4;
    const open = currentTime < this.holdUntil;
    const k = 1 - Math.exp(-1 / ((open ? 0.004 : 0.08) * sampleRate)); // открытие ~4 мс, закрытие ~80 мс
    const target = open ? 1 : 0;
    const o = out[0];
    let g = this.g;
    for (let i = 0; i < n; i++) { g += (target - g) * k; o[i] = inp[i] * vol * g; }
    this.g = g;
    for (let c = 1; c < out.length; c++) out[c].set(o);
    return true;
  }
}
registerProcessor('oreol-gate', OreolGate);
`;

const loaded = new WeakMap<BaseAudioContext, Promise<void>>();
function loadGate(ac: BaseAudioContext) {
  let p = loaded.get(ac);
  if (!p) {
    const url = URL.createObjectURL(new Blob([GATE_SRC], { type: 'application/javascript' }));
    p = ac.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
    loaded.set(ac, p);
  }
  return p;
}

const gateParams = () => {
  const p = getAudioPrefs();
  return { vol: p.inputVolume, auto: p.autoSensitivity, thr: p.sensitivity };
};

export function createMicProcessor(): TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  let src: MediaStreamAudioSourceNode | null = null;
  let node: AudioWorkletNode | GainNode | null = null;
  let dest: MediaStreamAudioDestinationNode | null = null;
  let unsub: (() => void) | null = null;

  const teardown = () => {
    unsub?.();
    unsub = null;
    [src, node].forEach((n) => n?.disconnect());
    src = node = null;
  };

  const build = async (opts: AudioProcessorOptions) => {
    const ac = opts.audioContext;
    if (ac.state === 'suspended') void ac.resume();
    src = ac.createMediaStreamSource(new MediaStream([opts.track]));
    dest ??= ac.createMediaStreamDestination();
    try {
      await loadGate(ac);
      const w = new AudioWorkletNode(ac, 'oreol-gate', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      w.port.postMessage(gateParams());
      unsub = subscribeAudioPrefs(() => w.port.postMessage(gateParams()));
      node = w;
    } catch {
      // Без AudioWorklet — только громкость ввода, без порога (лучше без ворот, чем с рваным звуком)
      const g = ac.createGain();
      g.gain.value = getAudioPrefs().inputVolume;
      unsub = subscribeAudioPrefs(() => g.gain.setTargetAtTime(getAudioPrefs().inputVolume, ac.currentTime, 0.03));
      node = g;
    }
    src.connect(node);
    node.connect(dest);
  };

  const proc: TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> = {
    name: 'oreol-mic',
    async init(opts) {
      await build(opts);
      proc.processedTrack = dest!.stream.getAudioTracks()[0];
    },
    async restart(opts) {
      // смена устройства: дорожка новая, выход тот же — собеседники ничего не замечают
      teardown();
      await build(opts);
    },
    async destroy() {
      teardown();
      dest?.stream.getTracks().forEach((t) => t.stop());
      dest = null;
    },
  };
  return proc;
}
