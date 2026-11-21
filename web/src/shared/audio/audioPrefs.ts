import { useSyncExternalStore } from 'react';

/** Настройки звука, сохраняются на этом устройстве. */
export interface AudioPrefs {
  /** deviceId микрофона ('' — системный по умолчанию). */
  inputId: string;
  /** deviceId динамиков/наушников ('' — системный по умолчанию). */
  outputId: string;
  /** Определять чувствительность автоматически (без шумового порога). */
  autoSensitivity: boolean;
  /** Порог голоса в дБ (SENS_MIN…SENS_MAX): тише — микрофон не передаёт звук. */
  sensitivity: number;
  /** Громкость микрофона, 0…2 (1 = как есть). */
  inputVolume: number;
  /** Громкость собеседников, 0…1. */
  outputVolume: number;
  /** deviceId камеры ('' — по умолчанию). */
  videoId: string;
  /** Звуки входа/выхода, микрофона, наушников и демонстрации. */
  sounds: boolean;
  /** Громкость звуков интерфейса, 0…1. */
  soundVolume: number;
}

const KEY = 'oreol.audio';
/** Диапазон порога: речь после автоусиления обычно −35…−15 дБ, поэтому 0 дБ (ничего не проходит) недоступен. */
export const SENS_MIN = -80;
export const SENS_MAX = -15;
const DEFAULTS: AudioPrefs = {
  inputId: '',
  outputId: '',
  autoSensitivity: true,
  sensitivity: -50,
  sounds: true,
  soundVolume: 0.6,
  inputVolume: 1,
  outputVolume: 1,
  videoId: '',
};
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

function load(): AudioPrefs {
  try {
    const p: AudioPrefs = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
    p.sensitivity = clamp(p.sensitivity, SENS_MIN, SENS_MAX);
    return p;
  } catch {
    return DEFAULTS;
  }
}

let prefs = load();
const listeners = new Set<() => void>();

export function getAudioPrefs() {
  return prefs;
}

export function setAudioPrefs(patch: Partial<AudioPrefs>) {
  prefs = { ...prefs, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* хранилище недоступно */
  }
  listeners.forEach((l) => l());
}

export function subscribeAudioPrefs(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useAudioPrefs() {
  return useSyncExternalStore(subscribeAudioPrefs, getAudioPrefs);
}

/** Можно ли выбрать устройство вывода (Chrome/Edge — да, Firefox/Safari — частично). */
export const canPickOutput = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

/** Уровень сигнала в дБ (−100…0) по анализатору. */
export function readLevel(an: AnalyserNode, buf: Float32Array<ArrayBuffer>) {
  an.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  const rms = Math.sqrt(sum / buf.length);
  return Math.max(-100, Math.min(0, 20 * Math.log10(rms || 1e-8)));
}
