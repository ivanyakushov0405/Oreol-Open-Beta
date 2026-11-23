import { useSyncExternalStore } from 'react';

export interface AudioPrefs {
  inputId: string;
  outputId: string;
  autoSensitivity: boolean;
  sensitivity: number;
  inputVolume: number;
  outputVolume: number;
  videoId: string;
  sounds: boolean;
  soundVolume: number;
}

const KEY = 'oreol.audio';
/** Threshold range: speech after auto gain is usually -35..-15 dB, so 0 dB (nothing passes) is not offered. */
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
    /* storage unavailable */
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

export const canPickOutput = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

export function readLevel(an: AnalyserNode, buf: Float32Array<ArrayBuffer>) {
  an.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  const rms = Math.sqrt(sum / buf.length);
  return Math.max(-100, Math.min(0, 20 * Math.log10(rms || 1e-8)));
}
