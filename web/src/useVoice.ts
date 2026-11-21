import { getToken } from './auth';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ConnectionQuality,
  Participant,
  DisconnectReason,
  RemoteTrack,
  type RemoteAudioTrack,
  Room,
  RoomEvent,
  Track,
  type LocalAudioTrack,
  type LocalTrackPublication,
  type RemoteTrackPublication,
} from 'livekit-client';
import { getAudioPrefs, subscribeAudioPrefs } from './audioPrefs';
import { createMicProcessor } from './micProcessor';
import { playSound } from './sounds';
import { getPeerVolume, subscribePeerVolume } from './peerVolume';

export interface VoicePeer {
  identity: string;
  isLocal: boolean;
  speaking: boolean;
  micMuted: boolean;
  camera?: Track;
  screen?: Track;
  /** Слышит ли участник других (для себя — состояние «Звук»; для других неизвестно). */
  deafened: boolean;
  /** Зашёл с телефона/планшета — определяется по устройству, а не по ширине окна. */
  mobile?: boolean;
}

/** Телефон или планшет: по данным браузера об устройстве (не по размеру экрана). */
export const IS_MOBILE_DEVICE: boolean = (() => {
  if (typeof navigator === 'undefined') return false;
  const uaData = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData;
  if (uaData?.mobile) return true;
  const ua = navigator.userAgent;
  if (/Android|iPhone|iPad|iPod|Mobile|Windows Phone|Opera Mini|IEMobile/i.test(ua)) return true;
  // iPadOS представляется как Mac — отличаем по сенсорному экрану
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
})();

export type Quality = 'good' | 'medium' | 'bad';

function toQuality(q: ConnectionQuality): Quality {
  if (q === ConnectionQuality.Excellent || q === ConnectionQuality.Good) return 'good';
  if (q === ConnectionQuality.Poor) return 'medium';
  if (q === ConnectionQuality.Lost) return 'bad';
  return 'good';
}

/** Пробует понять, что участник заглушил звук: метаданные { deafened: true }. */
function readDeafened(p: Participant) {
  try {
    return Boolean(p.metadata && JSON.parse(p.metadata).deafened);
  } catch {
    return false;
  }
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

/** Захват микрофона: автоусиление (тихий голос подтягивается), шумо- и эхоподавление, моно. */
const MIC_OPTIONS = { autoGainControl: true, noiseSuppression: true, echoCancellation: true, channelCount: 1 } as const;
/** Опции захвата с выбранным в настройках микрофоном. */
const micOptions = () => {
  const id = getAudioPrefs().inputId;
  return id ? { ...MIC_OPTIONS, deviceId: id } : { ...MIC_OPTIONS };
};

/** Реальный голосовой канал через LiveKit. */
/** Голос, в котором пользователь был, — чтобы после перезагрузки страницы вернуться в него. */
const LS_VOICE = 'oreol.voice';
const LS_MIC_OFF = 'oreol.micOff';
type SavedVoice = { server: string; startedAt: number };

export function savedVoice(): SavedVoice | null {
  try {
    const v = JSON.parse(localStorage.getItem(LS_VOICE) || 'null');
    return v && typeof v.server === 'string' ? v : null;
  } catch {
    return null;
  }
}

function saveVoice(v: SavedVoice | null) {
  try {
    if (v) localStorage.setItem(LS_VOICE, JSON.stringify(v));
    else localStorage.removeItem(LS_VOICE);
  } catch {
    /* хранилище недоступно — просто не восстановим */
  }
}

/** Событие «идёт проверка микрофона» (detail: true/false) — шлёт экран настроек звука. */
export const MIC_TEST_EVENT = 'oreol:mic-test';

const BYE = '{"t":"bye"}';

export function useVoice(user: string) {
  const roomRef = useRef<Room | null>(null);
  // Закрыли/перезагрузили страницу, будучи в канале: сервер уберёт нас, если не переподключимся за ~15 с
  useEffect(() => {
    const onHide = (e: PageTransitionEvent) => {
      if (e.persisted || !roomRef.current || !serverRef.current) return;
      const body = JSON.stringify({ server: serverRef.current, auth: getToken() ?? '' });
      navigator.sendBeacon('/api/voice/leaving', new Blob([body], { type: 'text/plain' }));
      // Собеседникам — «ухожу»: сервер уберёт нас только через ~15 с, а звук выхода у них должен прозвучать сразу
      try {
        void roomRef.current.localParticipant.publishData(new TextEncoder().encode(BYE), { reliable: true });
      } catch {
        /* не успели — звук прозвучит, когда сервер уберёт участника */
      }
    };
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, []);
  const audioBox = useRef<HTMLDivElement | null>(null);
  const deafRef = useRef(false);
  const serverRef = useRef<string | null>(null);
  // Если до перезагрузки были в голосе — сразу показываем «Подключение…», а не пустое состояние
  const [state, setState] = useState<'idle' | 'connecting' | 'connected'>(() => (savedVoice() ? 'connecting' : 'idle'));
  const [reconnecting, setReconnecting] = useState(false);
  const [peers, setPeers] = useState<VoicePeer[]>([]);
  const [quality, setQuality] = useState<Quality>('good');
  const [error, setError] = useState<string | null>(null);
  const [deafened, setDeafened] = useState(false);
  /** Микрофон можно выключить заранее, не заходя в канал: при входе он останется выключенным. */
  const [micWanted, setMicWanted] = useState(() => localStorage.getItem(LS_MIC_OFF) !== '1');
  const micWantedRef = useRef(micWanted);
  const setMicPref = (on: boolean) => {
    micWantedRef.current = on;
    setMicWanted(on);
    try {
      if (on) localStorage.removeItem(LS_MIC_OFF);
      else localStorage.setItem(LS_MIC_OFF, '1');
    } catch {
      /* приватный режим */
    }
  };
  const [startedAt, setStartedAt] = useState<number | null>(() => savedVoice()?.startedAt ?? null);
  const [rtt, setRtt] = useState<number | null>(null);
  /** Сервер, к голосу которого мы подключены (или подключаемся). */
  const [server, setServer] = useState<string | null>(() => savedVoice()?.server ?? null);

  if (!audioBox.current && typeof document !== 'undefined') {
    const box = document.createElement('div');
    box.style.display = 'none';
    document.body.appendChild(box);
    audioBox.current = box;
  }

  const refresh = useCallback(() => {
    const room = roomRef.current;
    if (room) setPeers(snapshot(room, deafRef.current));
  }, []);

  /** Звук собеседников идёт через WebAudio (webAudioMix): так громкость можно поднять выше 100%.
   *  Аудио-элементы LiveKit держит заглушёнными — громкость и «заглушить всех» ставим усилением дорожки. */
  const audioTracks = useRef(new Map<RemoteAudioTrack, string>());
  const gainFor = (who: string) => (deafRef.current ? 0 : getAudioPrefs().outputVolume * getPeerVolume(who));
  const applyGains = useCallback(() => {
    audioTracks.current.forEach((who, t) => t.setVolume(gainFor(who)));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const applyDeafen = useCallback((_on: boolean) => applyGains(), [applyGains]);

  /** Громкость собеседников: общая громкость × личная громкость собеседника (меню по ПКМ, до 200%). */
  const applyVolume = useCallback((_v: number) => applyGains(), [applyGains]);
  useEffect(() => subscribePeerVolume(() => applyVolume(getAudioPrefs().outputVolume)), [applyVolume]);

  const join = useCallback(async (serverId: string, resumeFrom?: number) => {
    const prev = roomRef.current;
    if (prev) {
      if (serverRef.current === serverId) return;
      // Переход в голос другого сервера: сначала выходим из текущего.
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
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken() ?? ''}` },
        body: JSON.stringify({ server: serverId, device: IS_MOBILE_DEVICE ? 'mobile' : 'desktop' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Не удалось получить токен');

      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
        audioCaptureDefaults: micOptions(),
        videoCaptureDefaults: getAudioPrefs().videoId ? { deviceId: getAudioPrefs().videoId } : undefined,
        audioOutput: getAudioPrefs().outputId ? { deviceId: getAudioPrefs().outputId } : undefined,
        publishDefaults: { dtx: false, red: true },
        // звук собеседников — через WebAudio: личная громкость до 200% (усиление дорожки, а не volume элемента)
        webAudioMix: true,
        // Перезагрузка страницы не должна выкидывать из канала: не отправляем «выход» при уходе со страницы.
        // После перезагрузки заходим с тем же именем — LiveKit заменяет старое подключение новым,
        // и остальные не видят выхода/входа. Если вкладку закрыли насовсем, сервер уберёт участника сам по таймауту.
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
      // Звуки входа/выхода собеседников. Перезагрузка у собеседника = замена подключения с тем же именем
      // (выход и вход почти одновременно) — такие пары не озвучиваем.
      const leaveTimers = new Map<string, number>();
      // кто уже «озвучен» как ушедший (по сигналу «ухожу») — когда сервер уберёт его позже, второй раз не звучит
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
        announced.delete(p.identity); // ушёл (звук был) и вернулся — это новый вход
        playSound('peer-join');
      });
      room.on(RoomEvent.ParticipantDisconnected, (p: Participant) => {
        if (room.remoteParticipants.has(p.identity)) return; // уже переподключился
        if (announced.delete(p.identity)) return; // выход уже прозвучал по сигналу «ухожу»
        // короткая пауза — только чтобы не озвучивать перезагрузку (выход и вход почти одновременно)
        leaveSoon(p.identity, 700);
      });
      // Собеседник закрыл/перезагрузил страницу: ждём чуть-чуть — если не вернулся, звучит выход
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
        if (roomRef.current !== room) return; // старая комната после перехода на другой сервер
        // Закрытие/перезагрузка вкладки — это CLIENT_INITIATED: запись оставляем, чтобы вернуться в голос.
        // Выкинул сервер или связь не восстановилась — забываем.
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
        throw new Error(`Не удалось подключиться к голосу (${data.url}): ${why}`);
      }
      try {
        if (micWantedRef.current) await room.localParticipant.setMicrophoneEnabled(true, micOptions());
      } catch {
        setError('Нет доступа к микрофону — вы в канале без звука');
      }
      await room.startAudio().catch(() => undefined);
      // После перезагрузки браузер может не дать играть звук без жеста — включаем по первому клику/нажатию
      if (!room.canPlaybackAudio) {
        const unlock = () => void room.startAudio().catch(() => undefined);
        window.addEventListener('pointerdown', unlock, { once: true });
        window.addEventListener('keydown', unlock, { once: true });
      }
      const started = resumeFrom ?? Date.now();
      setState('connected');
      setStartedAt(started);
      saveVoice({ server: serverId, startedAt: started });
      if (resumeFrom == null) playSound('join');
      refresh();
    } catch (e) {
      roomRef.current?.disconnect();
      roomRef.current = null;
      serverRef.current = null;
      setServer(null);
      setState('idle');
      saveVoice(null);
      setError(e instanceof Error ? e.message : 'Ошибка подключения к голосу');
    }
  }, [user, refresh]);

  const leave = useCallback(() => {
    saveVoice(null);
    if (!roomRef.current) {
      // ещё не подключились (например, восстановление после перезагрузки отменено)
      setState('idle');
      setServer(null);
      serverRef.current = null;
    }
    if (roomRef.current) playSound('leave');
    roomRef.current?.disconnect();
  }, []);

  // Микрофон и звук независимы: переключение одного не трогает другое.
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
      setError('Нет доступа к микрофону');
    }
    refresh();
  }, [refresh]);

  // Проверка микрофона в настройках: на время теста микрофон в звонке по-настоящему выключается
  // (собеседники не слышат проверку, а виджет и панель показывают «выключен»), после — возвращается как было.
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
      await room.localParticipant.setCameraEnabled(!room.localParticipant.isCameraEnabled, id ? { deviceId: id } : undefined);
    } catch {
      setError('Нет доступа к камере');
    }
    refresh();
  }, [refresh]);

  const toggleScreen = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    try {
      const next = !room.localParticipant.isScreenShareEnabled;
      await room.localParticipant.setScreenShareEnabled(next, { audio: true });
      if (room.localParticipant.isScreenShareEnabled === next) playSound(next ? 'share-on' : 'share-off');
    } catch {
      /* пользователь отменил выбор экрана */
    }
    refresh();
  }, [refresh]);

  // Пинг до сервера LiveKit: RTT активной ICE-пары WebRTC (запасной вариант — RTT сигнального канала).
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
          report?.forEach((r) => {
            const pair = r as RTCIceCandidatePairStats & { selected?: boolean };
            if (r.type === 'candidate-pair' && (pair.nominated || pair.selected) && pair.state === 'succeeded' && pair.currentRoundTripTime != null) {
              ms = Math.round(pair.currentRoundTripTime * 1000);
            }
          });
        } catch {
          /* транспорт ещё не готов */
        }
      }
      if (ms == null && engine?.client?.rtt) ms = Math.round(engine.client.rtt);
      if (alive) setRtt(ms);
    };
    void read();
    const id = window.setInterval(() => void read(), 2000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [state]);

  // Смена устройств в настройках — сразу и в активном звонке.
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

  // Обработка микрофона (громкость ввода + порог чувствительности) — процессор на дорожке LiveKit.
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
    quality,
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
    /** Дорожка своего микрофона (после обработки) — для индикатора уровня в виджете звонка. */
    micTrack: () => roomRef.current?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack,
  };
}

export type VoiceApi = ReturnType<typeof useVoice>;

/** Кто сейчас в голосовом (для сайдбара, пока сами не подключились). */
export function useVoiceRoster(enabled: boolean, server: string) {
  const [list, setList] = useState<{ identity: string; isMuted: boolean; mobile?: boolean }[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(`/api/voice/participants?server=${encodeURIComponent(server)}`);
        const d = await r.json();
        if (alive) setList(d.participants ?? []);
      } catch {
        /* бэкенд недоступен */
      }
    };
    setList([]);
    load();
    // Пока сам не в голосе, состав узнаём опросом — раньше раз в 5 с, и вошедшие появлялись с задержкой.
    // Теперь чаще, а при возвращении на вкладку — сразу.
    const id = window.setInterval(() => document.visibilityState === 'visible' && load(), 1500);
    const onVis = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      alive = false;
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [enabled, server]);
  return list;
}

/** Сколько человек в голосовом канале каждого сервера — для меток над иконками серверов. */
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
            return [s, (d.participants ?? []).length] as const;
          } catch {
            return [s, 0] as const;
          }
        }),
      );
      if (alive) setCounts(Object.fromEntries(entries));
    };
    void load();
    const id = window.setInterval(() => document.visibilityState === 'visible' && load(), 3000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [key]);
  return counts;
}
