import { useCallback, useEffect, useRef, useState } from 'react';
import { VideoPresets, ConnectionQuality, DisconnectReason, Participant, RemoteTrack, Room, RoomEvent, Track, type LocalAudioTrack, type LocalTrackPublication, type LocalVideoTrack, type RemoteAudioTrack, type RemoteTrackPublication } from 'livekit-client';

import { getAudioPrefs, subscribeAudioPrefs } from '../../shared/audio/audioPrefs';
import { playSound } from '../../shared/audio/sounds';
import { createMicProcessor } from './micProcessor';
import { voiceNow } from './voiceNow';
import { getPeerVolume, subscribePeerVolume } from './peerVolume';
import { VOICE_CHANGED, VOICE_LOCAL } from '../chat/useChat';
import { FLIP_EVENT, getFacing, setFacing } from './camFacing';
import { serverText, t } from '../../shared/i18n';

export interface VoicePeer {
  identity: string;
  isLocal: boolean;
  speaking: boolean;
  micMuted: boolean;
  camera?: Track;
  screen?: Track;
  camOn?: boolean;
  screenOn?: boolean;
  deafened: boolean;
  mobile?: boolean;
}

export const IS_MOBILE_DEVICE: boolean = (() => {
  if (typeof navigator === 'undefined') return false;
  const uaData = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData;
  if (uaData?.mobile) return true;
  const ua = navigator.userAgent;
  if (/Android|iPhone|iPad|iPod|Mobile|Windows Phone|Opera Mini|IEMobile/i.test(ua)) return true;
  // iPadOS reports itself as a Mac; tell it apart by the touch screen.
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
})();

export type Quality = 'good' | 'medium' | 'bad';

function toQuality(q: ConnectionQuality): Quality {
  if (q === ConnectionQuality.Excellent || q === ConnectionQuality.Good) return 'good';
  if (q === ConnectionQuality.Poor) return 'medium';
  if (q === ConnectionQuality.Lost) return 'bad';
  return 'good';
}

function readDeafened(p: Participant) {
  try {
    return Boolean(p.metadata && JSON.parse(p.metadata).deafened);
  } catch {
    return false;
  }
}

export const PING_MEDIUM = 200;
export const PING_BAD = 400;
function linkQuality(q: Quality, rtt: number | null): Quality {
  const rank = { good: 0, medium: 1, bad: 2 } as const;
  const byPing: Quality = rtt == null ? 'good' : rtt >= PING_BAD ? 'bad' : rtt >= PING_MEDIUM ? 'medium' : 'good';
  return rank[byPing] > rank[q] ? byPing : q;
}

function samePeers(a: VoicePeer[], b: VoicePeer[]) {
  return (
    a.length === b.length &&
    a.every((p, i) => {
      const q = b[i];
      return (
        p.identity === q.identity && p.isLocal === q.isLocal && p.speaking === q.speaking && p.micMuted === q.micMuted &&
        p.camera === q.camera && p.screen === q.screen && p.deafened === q.deafened && p.mobile === q.mobile
      );
    })
  );
}

function snapshot(room: Room, localDeafened: boolean): VoicePeer[] {
  const all: Participant[] = [room.localParticipant, ...room.remoteParticipants.values()];
  return all.map((p) => {
    const cam = p.getTrackPublication(Track.Source.Camera);
    const scr = p.getTrackPublication(Track.Source.ScreenShare);
    const mic = p.getTrackPublication(Track.Source.Microphone);
    const isLocal = p === room.localParticipant;
    return {
      identity: p.identity,
      isLocal,
      speaking: p.isSpeaking,
      micMuted: !mic || mic.isMuted,
      camera: cam && !cam.isMuted ? cam.track : undefined,
      screen: scr && !scr.isMuted ? scr.track : undefined,
      deafened: isLocal ? localDeafened : readDeafened(p),
      mobile: isLocal ? IS_MOBILE_DEVICE : p.attributes?.device === 'mobile',
    };
  });
}

const MIC_OPTIONS = { autoGainControl: true, noiseSuppression: true, echoCancellation: true, channelCount: 1 } as const;
const micOptions = () => {
  const id = getAudioPrefs().inputId;
  return id ? { ...MIC_OPTIONS, deviceId: id } : { ...MIC_OPTIONS };
};

const LS_VOICE = 'oreol.voice';
const LS_MIC_OFF = 'oreol.micOff';
type SavedVoice = { server: string; startedAt: number; seen?: number };
/** Rejoin voice only after a reload or a short drop: closing the tab and coming back later does not rejoin. */
const VOICE_RESUME_MS = 60_000;

export function savedVoice(): SavedVoice | null {
  try {
    const v = JSON.parse(localStorage.getItem(LS_VOICE) || 'null');
    if (!v || typeof v.server !== 'string') return null;
    if (!v.seen || Date.now() - v.seen > VOICE_RESUME_MS) {
      localStorage.removeItem(LS_VOICE);
      return null;
    }
    return v;
  } catch {
    return null;
  }
}

function saveVoice(v: SavedVoice | null) {
  try {
    if (v) localStorage.setItem(LS_VOICE, JSON.stringify({ ...v, seen: Date.now() }));
    else localStorage.removeItem(LS_VOICE);
  } catch {
    /* storage unavailable: rejoin is skipped */
  }
}

export const MIC_TEST_EVENT = 'oreol:mic-test';

const BYE = '{"t":"bye"}';

export function useVoice(user: string) {
  const roomRef = useRef<Room | null>(null);
  // Page closed or reloaded while in a channel: the server removes us unless we reconnect within ~15 s.
  useEffect(() => {
    const onHide = (e: PageTransitionEvent) => {
      if (e.persisted || !roomRef.current || !serverRef.current) return;
      const body = JSON.stringify({ server: serverRef.current });
      navigator.sendBeacon('/api/voice/leaving', new Blob([body], { type: 'text/plain' }));
      // Tell peers we are leaving: the server only removes us after ~15 s, but their leave sound should play now.
      try {
        void roomRef.current.localParticipant.publishData(new TextEncoder().encode(BYE), { reliable: true });
      } catch {
        /* too late: the sound plays when the server removes the participant */
      }
    };
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, []);
  const audioBox = useRef<HTMLDivElement | null>(null);
  const deafRef = useRef(false);
  const serverRef = useRef<string | null>(null);
  const [state, setState] = useState<'idle' | 'connecting' | 'connected'>(() => (savedVoice() ? 'connecting' : 'idle'));
  useEffect(() => {
    voiceNow.on = state !== 'idle';
  }, [state]);
  const [reconnecting, setReconnecting] = useState(false);
  const [peers, setPeers] = useState<VoicePeer[]>([]);
  const [quality, setQuality] = useState<Quality>('good');
  const [error, setError] = useState<string | null>(null);
  const [deafened, setDeafened] = useState(false);
  const [micWanted, setMicWanted] = useState(() => localStorage.getItem(LS_MIC_OFF) !== '1');
  const micWantedRef = useRef(micWanted);
  const setMicPref = (on: boolean) => {
    micWantedRef.current = on;
    setMicWanted(on);
    try {
      if (on) localStorage.removeItem(LS_MIC_OFF);
      else localStorage.setItem(LS_MIC_OFF, '1');
    } catch {
      /* private mode */
    }
  };
  const [startedAt, setStartedAt] = useState<number | null>(() => savedVoice()?.startedAt ?? null);
  const [rtt, setRtt] = useState<number | null>(null);
  const [server, setServer] = useState<string | null>(() => savedVoice()?.server ?? null);

  if (!audioBox.current && typeof document !== 'undefined') {
    const box = document.createElement('div');
    box.style.display = 'none';
    document.body.appendChild(box);
    audioBox.current = box;
  }

  const refresh = useCallback(() => {
    const room = roomRef.current;
    if (!room) return;
    const next = snapshot(room, deafRef.current);
    // LiveKit events come in bursts (track subscription, metadata, speakers) while the snapshot is often unchanged;
    // a new array re-rendered the whole app for nothing.
    setPeers((prev) => (samePeers(prev, next) ? prev : next));
  }, []);

  /**
   * Peer audio goes through WebAudio (webAudioMix) so volume can exceed 100%. LiveKit's audio elements stay muted;
   * volume and "mute all" are applied as track gain.
   */
  const audioTracks = useRef(new Map<RemoteAudioTrack, string>());
  const gainFor = (who: string) => (deafRef.current ? 0 : getAudioPrefs().outputVolume * getPeerVolume(who));
  const applyGains = useCallback(() => {
    audioTracks.current.forEach((who, t) => t.setVolume(gainFor(who)));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const applyDeafen = useCallback((_on: boolean) => applyGains(), [applyGains]);

  const applyVolume = useCallback((_v: number) => applyGains(), [applyGains]);
  useEffect(() => subscribePeerVolume(() => applyVolume(getAudioPrefs().outputVolume)), [applyVolume]);

  const join = useCallback(async (serverId: string, resumeFrom?: number) => {
    const prev = roomRef.current;
    if (prev) {
      if (serverRef.current === serverId) return;
      roomRef.current = null;
      await prev.disconnect();
    }
    serverRef.current = serverId;
    setServer(serverId);
    setError(null);
    setState('connecting');
    try {
      const res = await fetch('/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server: serverId, device: IS_MOBILE_DEVICE ? 'mobile' : 'desktop' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ? serverText(data.error) : t('Не удалось получить токен'));

      const room = new Room({
        // Remote camera quality follows the tile's real pixels: on iPhone one CSS pixel is 3 device pixels,
        // and sizing by CSS pixels delivered a layer three times smaller and a blurry picture.
        adaptiveStream: { pixelDensity: 'screen' },
        dynacast: true,
        audioCaptureDefaults: micOptions(),
        // Own camera at 720p 30 fps (without an explicit size phones often captured 640x480).
        videoCaptureDefaults: { resolution: VideoPresets.h720.resolution, ...(getAudioPrefs().videoId ? { deviceId: getAudioPrefs().videoId } : {}) },
        audioOutput: getAudioPrefs().outputId ? { deviceId: getAudioPrefs().outputId } : undefined,
        publishDefaults: { dtx: false, red: true, videoEncoding: { maxBitrate: 2_000_000, maxFramerate: 30 }, videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360] },
        webAudioMix: true,
        // A reload must not drop us from the channel, so no "leave" is sent when the page unloads.
        // After reload we join with the same identity: LiveKit replaces the old connection and others see no leave/join.
        // If the tab is closed for good, the server removes the participant on timeout.
        disconnectOnPageLeave: false,
      });
      roomRef.current = room;
      const events = [
        RoomEvent.ParticipantConnected,
        RoomEvent.ParticipantDisconnected,
        RoomEvent.ActiveSpeakersChanged,
        RoomEvent.TrackPublished,
        RoomEvent.TrackUnpublished,
        RoomEvent.TrackSubscribed,
        RoomEvent.TrackUnsubscribed,
        RoomEvent.TrackMuted,
        RoomEvent.TrackUnmuted,
        RoomEvent.LocalTrackPublished,
        RoomEvent.LocalTrackUnpublished,
        RoomEvent.ParticipantMetadataChanged,
      ] as const;
      events.forEach((ev) => room.on(ev, refresh));
      // Peer join/leave sounds. A peer reloading means the same identity reconnects
      // (leave and join almost at once); such pairs stay silent.
      const leaveTimers = new Map<string, number>();
      // Peers already announced as gone (via the "bye" signal) do not sound again when the server removes them later.
      const announced = new Set<string>();
      const leaveSoon = (who: string, ms: number) => {
        window.clearTimeout(leaveTimers.get(who));
        leaveTimers.set(
          who,
          window.setTimeout(() => {
            leaveTimers.delete(who);
            announced.add(who);
            playSound('peer-leave');
          }, ms),
        );
      };
      room.on(RoomEvent.ParticipantConnected, (p: Participant) => {
        const t = leaveTimers.get(p.identity);
        if (t != null) {
          window.clearTimeout(t);
          leaveTimers.delete(p.identity);
          return;
        }
        announced.delete(p.identity); // Left (sound played) and came back: a new join.
        playSound('peer-join');
      });
      room.on(RoomEvent.ParticipantDisconnected, (p: Participant) => {
        if (room.remoteParticipants.has(p.identity)) return;
        if (announced.delete(p.identity)) return;
        // A short pause only to keep reloads silent (leave and join almost at once).
        leaveSoon(p.identity, 700);
      });
      // A peer closed or reloaded the page: wait a little, and play the leave sound if they do not return.
      room.on(RoomEvent.DataReceived, (data: Uint8Array, who?: Participant) => {
        if (!who || new TextDecoder().decode(data) !== BYE) return;
        leaveSoon(who.identity, 2500);
      });
      room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub: RemoteTrackPublication, who: Participant) => {
        if (track.kind === Track.Kind.Audio) {
          const el = track.attach();
          (el as HTMLAudioElement).dataset.peer = who.identity;
          audioBox.current?.appendChild(el);
          audioTracks.current.set(track as RemoteAudioTrack, who.identity);
          (track as RemoteAudioTrack).setVolume(gainFor(who.identity));
        }
      });
      room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        audioTracks.current.delete(track as RemoteAudioTrack);
        track.detach().forEach((el) => el.remove());
      });
      room.on(RoomEvent.ConnectionQualityChanged, (q: ConnectionQuality, p: Participant) => {
        if (p === room.localParticipant) setQuality(toQuality(q));
      });
      room.on(RoomEvent.Reconnecting, () => {
        setQuality('bad');
        setReconnecting(true);
      });
      room.on(RoomEvent.Reconnected, () => {
        setQuality('good');
        setReconnecting(false);
      });
      room.on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
        if (roomRef.current !== room) return;
        // Closing or reloading the tab is CLIENT_INITIATED: keep the record to rejoin voice.
        // Kicked by the server or the connection did not recover: forget it.
        if (reason !== DisconnectReason.CLIENT_INITIATED) saveVoice(null);
        roomRef.current = null;
        serverRef.current = null;
        setServer(null);
        setState('idle');
        setReconnecting(false);
        setPeers([]);
        setStartedAt(null);
      });
      room.on(RoomEvent.LocalTrackUnpublished, (pub: LocalTrackPublication) => {
        pub.track?.detach();
      });

      try {
        await room.connect(data.url, data.token);
      } catch (err) {
        console.error('LiveKit connect failed', data.url, err);
        const why = err instanceof Error ? err.message : String(err);
        throw new Error(t('Не удалось подключиться к голосу ({0}): {1}', { 0: data.url, 1: why }));
      }
      try {
        if (micWantedRef.current) await room.localParticipant.setMicrophoneEnabled(true, micOptions());
      } catch {
        setError(t('Нет доступа к микрофону, вы в канале без звука'));
      }
      await room.startAudio().catch(() => undefined);
      // After reload the browser may block audio until a gesture; resume on the first click or tap.
      if (!room.canPlaybackAudio) {
        const unlock = () => void room.startAudio().catch(() => undefined);
        window.addEventListener('pointerdown', unlock, { once: true });
        window.addEventListener('keydown', unlock, { once: true });
      }
      if (roomRef.current !== room) {
        void room.disconnect();
        return;
      }
      const started = resumeFrom ?? Date.now();
      setState('connected');
      setStartedAt(started);
      saveVoice({ server: serverId, startedAt: started });
      if (resumeFrom == null) playSound('join');
      refresh();
    } catch (e) {
      if (serverRef.current !== serverId) return;
      roomRef.current?.disconnect();
      roomRef.current = null;
      serverRef.current = null;
      setServer(null);
      setState('idle');
      saveVoice(null);
      setError(e instanceof Error ? e.message : t('Ошибка подключения к голосу'));
    }
  }, [user, refresh]);

  // While in voice, mark the tab alive: after a reload this mark brings us back to voice,
  // but not if the tab was closed and reopened more than a minute later.
  useEffect(() => {
    if (state !== 'connected' || !server || startedAt == null) return;
    const mark = () => serverRef.current === server && roomRef.current && saveVoice({ server, startedAt });
    mark();
    const id = window.setInterval(mark, 15_000);
    window.addEventListener('pagehide', mark);
    document.addEventListener('visibilitychange', mark);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('pagehide', mark);
      document.removeEventListener('visibilitychange', mark);
    };
  }, [state, server, startedAt]);

  const leave = useCallback(() => {
    saveVoice(null);
    if (!roomRef.current) {
      setState('idle');
      setServer(null);
      serverRef.current = null;
    }
    const room = roomRef.current;
    if (!room) return;
    // Play the leave sound first and disconnect when it ends: on iPhone stopping the microphone
    // switches the phone's audio route and cut the sound. The UI leaves immediately.
    const connected = room.state === 'connected';
    if (connected) playSound('leave');
    roomRef.current = null;
    serverRef.current = null;
    setServer(null);
    setState('idle');
    setReconnecting(false);
    setPeers([]);
    setStartedAt(null);
    if (!connected) return void room.disconnect();
    // Peers can no longer hear us or be heard, though the connection lives until the sound ends.
    audioTracks.current.forEach((_who, t) => t.setVolume(0));
    room.localParticipant.getTrackPublication(Track.Source.Microphone)?.mute().catch(() => undefined);
    window.setTimeout(() => {
      void room.disconnect().finally(() => window.dispatchEvent(new Event(VOICE_LOCAL)));
    }, 650);
  }, []);

  const toggleMic = useCallback(async () => {
    const room = roomRef.current;
    if (!room || room.state !== 'connected') {
      const next = !micWantedRef.current;
      setMicPref(next);
      playSound(next ? 'mic-on' : 'mic-off');
      return;
    }
    try {
      const next = !room.localParticipant.isMicrophoneEnabled;
      await room.localParticipant.setMicrophoneEnabled(next, micOptions());
      setMicPref(next);
      playSound(next ? 'mic-on' : 'mic-off');
    } catch {
      setError(t('Нет доступа к микрофону'));
    }
    refresh();
  }, [refresh]);

  // Microphone test in settings: the call microphone is really muted for the duration
  // (peers do not hear the test and the UI shows it as muted), then restored.
  useEffect(() => {
    let held = false;
    const onTest = (e: Event) => {
      const on = (e as CustomEvent<boolean>).detail;
      const pub = roomRef.current?.localParticipant.getTrackPublication(Track.Source.Microphone);
      if (on) {
        if (!pub || pub.isMuted || roomRef.current?.state !== 'connected') return;
        held = true;
        void pub.mute().finally(refresh);
      } else if (held) {
        held = false;
        if (pub && micWantedRef.current) void pub.unmute().finally(refresh);
      }
    };
    window.addEventListener(MIC_TEST_EVENT, onTest);
    return () => window.removeEventListener(MIC_TEST_EVENT, onTest);
  }, [refresh]);

  const toggleDeafen = useCallback(async () => {
    const next = !deafRef.current;
    deafRef.current = next;
    setDeafened(next);
    applyDeafen(next);
    playSound(next ? 'deafen' : 'undeafen');
    roomRef.current?.localParticipant.setMetadata(JSON.stringify({ deafened: next })).catch(() => undefined);
    refresh();
  }, [applyDeafen, refresh]);

  const toggleCamera = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    try {
      const id = getAudioPrefs().videoId;
      const turnOn = !room.localParticipant.isCameraEnabled;
      // On phones without a camera chosen in settings, use the last one (front by default).
      if (turnOn && !id && IS_MOBILE_DEVICE) {
        await room.localParticipant.setCameraEnabled(true, { resolution: VideoPresets.h720.resolution, facingMode: getFacing() });
      } else {
        if (turnOn) setFacing('user');
        await room.localParticipant.setCameraEnabled(turnOn, { resolution: VideoPresets.h720.resolution, ...(id ? { deviceId: id } : {}) });
      }
    } catch {
      setError(t('Нет доступа к камере'));
    }
    refresh();
  }, [refresh]);

  // Switch front/back camera by restarting the same track with another camera,
  // so peers see the change without the video turning off.
  useEffect(() => {
    let busy = false;
    const onFlip = async () => {
      const track = roomRef.current?.localParticipant.getTrackPublication(Track.Source.Camera)?.track as LocalVideoTrack | undefined;
      if (!track || busy) return;
      busy = true;
      const next = getFacing() === 'user' ? 'environment' : 'user';
      try {
        await track.restartTrack({ facingMode: next, resolution: VideoPresets.h720.resolution });
        setFacing(next);
      } catch {
        setError(t('Не удалось переключить камеру'));
      } finally {
        busy = false;
        refresh();
      }
    };
    window.addEventListener(FLIP_EVENT, onFlip);
    return () => window.removeEventListener(FLIP_EVENT, onFlip);
  }, [refresh]);

  const toggleScreen = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    try {
      const next = !room.localParticipant.isScreenShareEnabled;
      await room.localParticipant.setScreenShareEnabled(next, { audio: true });
      if (room.localParticipant.isScreenShareEnabled === next) playSound(next ? 'share-on' : 'share-off');
    } catch {
      /* user cancelled the screen picker */
    }
    refresh();
  }, [refresh]);

  // Joined or left voice: tell everyone through the chat socket so their lists update without delay.
  const wasIn = useRef(false);
  useEffect(() => {
    const inNow = state === 'connected';
    if (inNow !== wasIn.current) window.dispatchEvent(new Event(VOICE_LOCAL));
    wasIn.current = inNow;
  }, [state]);

  // Ping to LiveKit: RTT of the active ICE candidate pair (fallback: signalling RTT).
  useEffect(() => {
    if (state !== 'connected') {
      setRtt(null);
      return;
    }
    type Transport = { getStats(): Promise<RTCStatsReport> | undefined };
    type Engine = { pcManager?: { publisher?: Transport; subscriber?: Transport }; client?: { rtt?: number } };
    let alive = true;
    const read = async () => {
      const engine = (roomRef.current as unknown as { engine?: Engine } | null)?.engine;
      let ms: number | null = null;
      for (const t of [engine?.pcManager?.subscriber, engine?.pcManager?.publisher]) {
        if (!t || ms != null) continue;
        try {
          const report = await t.getStats();
          if (!report) continue;
          // The pair actually carrying traffic comes from transport stats; otherwise any selected/nominated pair.
          // Chrome sometimes reports currentRoundTripTime as 0 (no checks yet or a stale pair); then use
          // totalRoundTripTime / responsesReceived and never show zero.
          let selectedId: string | undefined;
          report.forEach((r) => {
            if (r.type === 'transport' && (r as RTCTransportStats).selectedCandidatePairId) selectedId = (r as RTCTransportStats).selectedCandidatePairId;
          });
          const pairRtt = (pair: RTCIceCandidatePairStats) => {
            if (pair.currentRoundTripTime && pair.currentRoundTripTime > 0) return pair.currentRoundTripTime * 1000;
            if (pair.totalRoundTripTime && pair.responsesReceived) return (pair.totalRoundTripTime / pair.responsesReceived) * 1000;
            return null;
          };
          let best: number | null = null;
          report.forEach((r) => {
            if (r.type !== 'candidate-pair') return;
            const pair = r as RTCIceCandidatePairStats & { selected?: boolean };
            const chosen = selectedId ? r.id === selectedId : (pair.nominated || pair.selected) && pair.state === 'succeeded';
            if (!chosen) return;
            const v = pairRtt(pair);
            if (v != null && v > 0) best = v;
          });
          if (best != null) ms = Math.max(1, Math.round(best));
        } catch {
          /* transport not ready yet */
        }
      }
      if (ms == null && engine?.client?.rtt && engine.client.rtt > 0) ms = Math.max(1, Math.round(engine.client.rtt));
      if (alive) setRtt(ms);
    };
    void read();
    const id = window.setInterval(() => void read(), 2000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [state]);

  useEffect(() => {
    let last = getAudioPrefs();
    return subscribeAudioPrefs(() => {
      const p = getAudioPrefs();
      const room = roomRef.current;
      if (room && p.inputId !== last.inputId) void room.switchActiveDevice('audioinput', p.inputId || 'default').catch(() => undefined);
      if (room && p.outputId !== last.outputId) void room.switchActiveDevice('audiooutput', p.outputId || 'default').catch(() => undefined);
      if (room && p.videoId !== last.videoId) void room.switchActiveDevice('videoinput', p.videoId || 'default').catch(() => undefined);
      if (p.outputVolume !== last.outputVolume) applyVolume(p.outputVolume);
      last = p;
    });
  }, []);

  useEffect(() => {
    if (state !== 'connected') return;
    let ac: AudioContext | null = null;
    let busy = false;
    const ensure = async () => {
      const track = roomRef.current?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track as LocalAudioTrack | undefined;
      if (!track || track.getProcessor() || busy) return;
      busy = true;
      try {
        ac ??= new AudioContext();
        await track.setAudioContext(ac);
        await track.setProcessor(createMicProcessor());
      } catch (e) {
        console.warn('mic processor', e);
      } finally {
        busy = false;
      }
    };
    void ensure();
    const id = window.setInterval(() => void ensure(), 500);
    return () => {
      window.clearInterval(id);
      void ac?.close();
    };
  }, [state]);

  useEffect(() => () => roomRef.current?.disconnect() as unknown as void, []);

  const local = peers.find((p) => p.isLocal);
  return {
    state,
    server,
    peers,
    // One link quality for everything (status, icon, dot, ping color): the worse of LiveKit's estimate and ping.
    // Status used to follow LiveKit while ping had its own thresholds, giving a green "Connected" next to a red ping.
    quality: linkQuality(quality, rtt),
    reconnecting,
    error,
    clearError: () => setError(null),
    startedAt,
    micOn: local ? !local.micMuted : micWanted,
    cameraOn: Boolean(local?.camera),
    screenOn: Boolean(local?.screen),
    deafened,
    rtt,
    join,
    leave,
    toggleMic,
    toggleDeafen,
    toggleCamera,
    toggleScreen,
    micTrack: () => roomRef.current?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack,
  };
}

export type VoiceApi = ReturnType<typeof useVoice>;

export type RosterEntry = { identity: string; isMuted: boolean; deafened?: boolean; camera?: boolean; screen?: boolean; mobile?: boolean };
const NO_ROSTER: RosterEntry[] = [];
/**
 * seed: who was in the channel with us (excluding us). Right after leaving the list is not loaded yet,
 * so show them instead of nothing; otherwise tiles vanished and reappeared.
 */
/**
 * Last known voice roster per server, so switching servers shows people at once. Also fed by the
 * server icon labels poll (useVoiceCounts).
 */
const rosterCache = new Map<string, RosterEntry[]>();

export function useVoiceRoster(enabled: boolean, server: string, seed?: RosterEntry[]) {
  const [list, setList] = useState<{ server: string; items: RosterEntry[] } | null>(null);
  const seedRef = useRef<{ server: string; items: RosterEntry[]; at: number }>({ server: '', items: NO_ROSTER, at: 0 });
  if (!enabled && seed) seedRef.current = { server, items: seed, at: Date.now() };
  useEffect(() => {
    if (!enabled) {
      setList(null);
      return;
    }
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(`/api/voice/participants?server=${encodeURIComponent(server)}`);
        const d = await r.json();
        // Same roster, same array: otherwise the whole app re-rendered every 1.5 s.
        const next: RosterEntry[] = d.participants ?? [];
        rosterCache.set(server, next);
        if (alive) setList((prev) => (prev && prev.server === server && JSON.stringify(prev.items) === JSON.stringify(next) ? prev : { server, items: next }));
      } catch {
        /* backend unavailable */
      }
    };
    load();
    // Someone else joined or left: refetch now and once more a bit later (LiveKit removes leavers with a delay).
    let again = 0;
    const onVoice = () => {
      void load();
      window.clearTimeout(again);
      again = window.setTimeout(() => void load(), 900);
    };
    window.addEventListener(VOICE_CHANGED, onVoice);
    // While not in voice the roster is polled, more often than the old 5 s, and immediately when the tab becomes visible.
    const id = window.setInterval(() => document.visibilityState === 'visible' && load(), 1500);
    const onVis = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      alive = false;
      window.clearInterval(id);
      window.clearTimeout(again);
      window.removeEventListener(VOICE_CHANGED, onVoice);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [enabled, server]);
  if (list && list.server === server) return list.items;
  if (!enabled) return NO_ROSTER;
  // The roster from our own voice session is only used right after leaving, until the list arrives. Kept forever, it
  // showed long-gone "ghosts" when switching servers.
  const sd = seedRef.current;
  if (sd.server === server && Date.now() - sd.at < 4000) return sd.items;
  return rosterCache.get(server) ?? NO_ROSTER;
}

export function useVoiceCounts(servers: string[]) {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const key = servers.join(',');
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const entries = await Promise.all(
        key.split(',').map(async (s) => {
          try {
            const r = await fetch(`/api/voice/participants?server=${encodeURIComponent(s)}`);
            const d = await r.json();
            const list: RosterEntry[] = d.participants ?? [];
            const old = rosterCache.get(s);
            if (!old || JSON.stringify(old) !== JSON.stringify(list)) rosterCache.set(s, list);
            return [s, list.length] as const;
          } catch {
            return [s, 0] as const;
          }
        }),
      );
      const next = Object.fromEntries(entries);
      if (alive) setCounts((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    void load();
    const id = window.setInterval(() => document.visibilityState === 'visible' && load(), 3000);
    let again = 0;
    const onVoice = () => {
      void load();
      window.clearTimeout(again);
      again = window.setTimeout(() => void load(), 900);
    };
    window.addEventListener(VOICE_CHANGED, onVoice);
    return () => {
      alive = false;
      window.clearInterval(id);
      window.clearTimeout(again);
      window.removeEventListener(VOICE_CHANGED, onVoice);
    };
  }, [key]);
  return counts;
}
