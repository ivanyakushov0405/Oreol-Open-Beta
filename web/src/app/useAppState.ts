import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChat } from '../features/chat/useChat';
import { IS_MOBILE_DEVICE, savedVoice, useVoice, useVoiceRoster, type RosterEntry, type VoicePeer } from '../features/voice/useVoice';
import { api, putUser, refreshUsers, type Me, type Member } from '../shared/api';
import type { Server, ServerId, Status } from '../shared/model';
import { useToast, type ToastKind } from '../shared/ui/Toast';
import { t } from '../shared/i18n';
import { useServerUnread } from '../features/servers/serverUnread';

export type Theme = 'dark' | 'light';
export type ThemePref = 'system' | Theme;

const SYSTEM_LIGHT = '(prefers-color-scheme: light)';
export const systemTheme = (): Theme => (window.matchMedia(SYSTEM_LIGHT).matches ? 'light' : 'dark');

export function useSystemTheme() {
  const [t, setT] = useState<Theme>(systemTheme);
  useEffect(() => {
    const mq = window.matchMedia(SYSTEM_LIGHT);
    // iOS flips the scheme of a backgrounded page to snapshot it for the app switcher in both looks; following that
    // flashed the other theme on return. A hidden page ignores changes and reads the scheme when it is shown again.
    const on = () => !document.hidden && setT(mq.matches ? 'light' : 'dark');
    mq.addEventListener('change', on);
    document.addEventListener('visibilitychange', on);
    return () => {
      mq.removeEventListener('change', on);
      document.removeEventListener('visibilitychange', on);
    };
  }, []);
  return t;
}

/** Theme or transparency change: enable surface transitions for half a second so blurred panels do not jump. */
export function animateSurfaces() {
  const html = document.documentElement;
  // The View Transition reveal animates theme changes itself; extra transitions on top caused a second flash.
  if (html.dataset.vt) return;
  html.classList.add('glass-anim');
  window.clearTimeout(Number(html.dataset.glassAnimT));
  html.dataset.glassAnimT = String(window.setTimeout(() => html.classList.remove('glass-anim'), 560));
}

export const LS_NAME = 'oreol.name';
export const LS_THEME = 'oreol.theme';
const LS_GLASS = 'oreol.glassChat';
const LS_GLASS_VOICE = 'oreol.glassVoice';
const LS_GLASS_UI = 'oreol.glassUi';
const LS_PATTERN = 'oreol.chatPattern';
const LS_LIVE_BG = 'oreol.liveBg';
const LS_GLOWS = 'oreol.bgGlows';
const LS_SERVER = 'oreol.server';
const LS_STATUS = 'oreol.status';

export function lsGet(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function lsSet(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

export function useIsMobile() {
  // A phone in landscape is still mobile: wide enough for desktop, but short and touch-only.
  const q = '(max-width: 768px), (pointer: coarse) and (max-height: 520px)';
  const [m, setM] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setM(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return m;
}

export function useAppState(
  me: Me,
  servers: Server[],
  setMe: (u: Me) => void,
  logout: () => void,
  theme: Theme,
  themePref: ThemePref,
  setTheme: (t: ThemePref) => void,
) {
  const name = me.username;
  useEffect(() => {
    putUser(me);
    void refreshUsers();
    const id = window.setInterval(() => void refreshUsers(), 30000);
    return () => window.clearInterval(id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const updateMe = (u: Me) => {
    setMe(u);
    putUser(u);
  };
  const [glassUi, setGlassUiState] = useState(() => lsGet(LS_GLASS_UI) === '1');
  const setGlassUi = (v: boolean) => {
    setGlassUiState(v);
    lsSet(LS_GLASS_UI, v ? '1' : '0');
  };
  const [glassChatPref, setGlassChatState] = useState(() => lsGet(LS_GLASS) === '1');
  const setGlassChat = (v: boolean) => {
    setGlassChatState(v);
    lsSet(LS_GLASS, v ? '1' : '0');
  };
  const [glassVoicePref, setGlassVoiceState] = useState(() => lsGet(LS_GLASS_VOICE) === '1');
  const setGlassVoice = (v: boolean) => {
    setGlassVoiceState(v);
    lsSet(LS_GLASS_VOICE, v ? '1' : '0');
  };
  const [chatPattern, setChatPatternState] = useState(() => lsGet(LS_PATTERN) !== '0');
  const setChatPattern = (v: boolean) => {
    setChatPatternState(v);
    lsSet(LS_PATTERN, v ? '1' : '0');
  };
  const [liveBg, setLiveBgState] = useState(() => lsGet(LS_LIVE_BG) === '1');
  const setLiveBg = (v: boolean) => {
    setLiveBgState(v);
    lsSet(LS_LIVE_BG, v ? '1' : '0');
  };
  const [bgGlowsPref, setBgGlowsState] = useState(() => lsGet(LS_GLOWS) === '1');
  const setBgGlows = (v: boolean) => {
    setBgGlowsState(v);
    lsSet(LS_GLOWS, v ? '1' : '0');
  };
  const bgGlows = liveBg && bgGlowsPref;
  const glassChat = glassUi && glassChatPref;
  const glassVoice = glassUi && glassVoicePref;
  useEffect(() => {
    const d = document.documentElement.dataset;
    const next = glassUi ? 'on' : 'off';
    if (d.glass && d.glass !== next) animateSurfaces();
    d.glass = next;
    d.pattern = chatPattern ? 'on' : 'off';
    const bg = liveBg ? 'on' : 'off';
    // While the backdrop toggles, the glows do not animate on their own: each SVG frame recomputes the torus blur
    // and the backdrop flickered on phones. They fade with the whole layer instead.
    if (d.backdrop && d.backdrop !== bg) {
      d.bgSwitch = '';
      window.clearTimeout(Number(d.bgSwitchT));
      d.bgSwitchT = String(window.setTimeout(() => delete document.documentElement.dataset.bgSwitch, 700));
    }
    d.backdrop = bg;
    d.glows = bgGlows ? 'on' : 'off';
  }, [glassUi, chatPattern, liveBg, bgGlows]);
  const serverById = useCallback((id: string | null | undefined) => servers.find((s) => s.id === id), [servers]);
  const [serverId, setServerIdState] = useState<ServerId>(() => (serverById(lsGet(LS_SERVER)) ?? servers[0]).id);
  const setServerId = (id: ServerId) => {
    setServerIdState(id);
    lsSet(LS_SERVER, id);
  };
  const server = serverById(serverId) ?? servers[0];
  const textChannel = server.channels.find((c) => c.kind === 'text') ?? null;
  const voiceChannel = server.channels.find((c) => c.kind === 'voice') ?? null;
  const [status, setStatusState] = useState<Status>(me.status ?? 'online');
  useEffect(() => lsSet(LS_STATUS, null), []);
  const voice = useVoice(name);
  const general = useChat(textChannel?.room ?? null, name);
  const lobby = useChat(voiceChannel?.room ?? null, name);
  const serverUnread = useServerUnread(serverId, general.myRead, lobby.myRead);
  // A freshly opened socket has no presence yet: keep the last known one instead of showing everyone offline.
  const lastStatuses = useRef<Record<string, Status>>({});
  const statuses = useMemo(() => {
    const next = { ...lobby.statuses, ...general.statuses };
    if (!Object.keys(next).length) return lastStatuses.current;
    return (lastStatuses.current = next);
  }, [general.statuses, lobby.statuses]);
  // Who went offline while we watched: their last visit is now, until the member list reloads.
  const prevStatuses = useRef(statuses);
  const [seenNow, setSeenNow] = useState<Record<string, string>>({});
  useEffect(() => {
    const gone = Object.keys(prevStatuses.current).filter((n) => !statuses[n]);
    prevStatuses.current = statuses;
    if (!gone.length) return;
    const at = new Date().toISOString();
    setSeenNow((s) => ({ ...s, ...Object.fromEntries(gone.map((n) => [n, at])) }));
  }, [statuses]);
  // Show the last known member list when switching servers, otherwise "n online" shows 0 for a moment.
  const memberCache = useRef(new Map<string, Member[]>());
  const [memberRows, setMemberRows] = useState<Member[]>([]);
  const loadMembers = useCallback(async () => {
    try {
      const r = await api<{ members: Member[] }>(`/api/servers/${encodeURIComponent(serverId)}/members`);
      r.members.forEach(putUser);
      memberCache.current.set(serverId, r.members);
      setMemberRows(r.members);
    } catch {
      /* ignore */
    }
  }, [serverId]);
  useEffect(() => {
    setMemberRows(memberCache.current.get(serverId) ?? []);
    void loadMembers();
    const id = window.setInterval(() => void loadMembers(), 30000);
    return () => window.clearInterval(id);
  }, [loadMembers]);
  useEffect(() => {
    if (memberRows.length && Object.keys(statuses).some((n) => !memberRows.some((m) => m.username === n))) void loadMembers();
  }, [statuses]); // eslint-disable-line react-hooks/exhaustive-deps
  const statusOf = useCallback((n: string): Status => (n === name ? status : statuses[n] ?? 'offline'), [name, status, statuses]);
  const members = useMemo(
    () => memberRows.map((m) => ({ ...m, status: statusOf(m.username), lastSeen: seenNow[m.username] ?? m.lastSeen })),
    [memberRows, statusOf, seenNow],
  );
  const lastSeenOf = useCallback((n: string) => members.find((m) => m.username === n)?.lastSeen ?? null, [members]);
  const membersOnline = members.filter((m) => m.status !== 'offline');
  const membersOffline = members.filter((m) => m.status === 'offline');
  const membersReady = memberCache.current.has(serverId);
  const inVoiceHere = voice.state !== 'idle' && voice.server === serverId;
  const liveHere = inVoiceHere && voice.state === 'connected';
  // Right after leaving this server's voice the server still lists us for a second; hide ourselves meanwhile,
  // otherwise our tile reappears and slides out again.
  const wasLive = useRef(false);
  const hideSelfUntil = useRef(0);
  if (wasLive.current && !liveHere && voice.state === 'idle') hideSelfUntil.current = Date.now() + 5000;
  if (voice.state === 'connecting') hideSelfUntil.current = 0;
  wasLive.current = liveHere;
  const seed: RosterEntry[] | undefined = liveHere
    ? voice.peers.filter((p) => !p.isLocal).map((p) => ({ identity: p.identity, isMuted: p.micMuted, deafened: p.deafened, camera: Boolean(p.camera), screen: Boolean(p.screen), mobile: p.mobile }))
    : undefined;
  const rosterAll = useVoiceRoster(!liveHere, serverId, seed);
  const roster = hideSelfUntil.current > Date.now() ? rosterAll.filter((r) => r.identity !== name) : rosterAll;
  const joinVoice = () => {
    if (!inVoiceHere) void voice.join(serverId);
  };
  const { toast, show } = useToast();
  useEffect(() => {
    const saved = savedVoice();
    if (saved && serverById(saved.server)) void voice.join(saved.server, saved.startedAt);
    else if (saved) voice.leave();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const setStatus = (s: Status) => {
    const prev = status;
    setStatusState(s);
    setMe({ ...me, status: s });
    api('/api/status', { method: 'PUT', body: { status: s } }).catch(() => {
      setStatusState(prev);
      show(t('Не удалось сменить статус'), 'error');
    });
  };

  useEffect(() => {
    if (voice.error) {
      show(voice.error, 'error');
      voice.clearError();
    }
  }, [voice.error, show, voice]);

  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  const everConnected = useRef(false);
  const [lost, setLost] = useState(false);
  // On phones the chat header shows the connection state itself, no banners or toasts.
  const phoneUi = useIsMobile();
  /** Phones drop the socket in the background and reconnect on return; that is not a lost connection. */
  const shownAt = useRef(Date.now());
  useEffect(() => {
    const vis = () => document.visibilityState === 'visible' && (shownAt.current = Date.now());
    document.addEventListener('visibilitychange', vis);
    return () => document.removeEventListener('visibilitychange', vis);
  }, []);
  useEffect(() => {
    if (general.connected) {
      if (lost && !phoneUi) show(t('Соединение восстановлено'), 'success');
      everConnected.current = true;
      setLost(false);
      return;
    }
    if (!everConnected.current) return;
    // Short drops (channel switch, socket restart, returning to the app) are not shown.
    let id = 0;
    const check = () => {
      const fresh = Date.now() - shownAt.current < 5000;
      if (document.visibilityState === 'visible' && !fresh) setLost(true);
      else id = window.setTimeout(check, 1000);
    };
    id = window.setTimeout(check, 1500);
    return () => window.clearTimeout(id);
  }, [general.connected]); // eslint-disable-line react-hooks/exhaustive-deps
  const connBanner = !online
    ? t('Нет подключения к интернету')
    : lost && !phoneUi
      ? t('Нет связи с сервером, переподключаемся…')
      : voice.reconnecting
        ? t('Голосовой канал: переподключаемся…')
        : null;

  // Who is in the current server's lobby: from LiveKit when we are in it, otherwise polled from the backend.
  const voiceSource: 'live' | 'roster' = inVoiceHere && voice.state === 'connected' ? 'live' : 'roster';
  const voiceUsers: VoicePeer[] =
    voiceSource === 'live'
      ? voice.peers
      : [
          ...roster.map((r) => ({ identity: r.identity, isLocal: r.identity === name, speaking: false, micMuted: r.isMuted, deafened: Boolean(r.deafened), camOn: Boolean(r.camera), screenOn: Boolean(r.screen), mobile: Boolean(r.mobile) })),
          // While reconnecting (e.g. after reload) show ourselves in the channel right away.
          ...(inVoiceHere && voice.state === 'connecting' && !roster.some((r) => r.identity === name)
            ? [{ identity: name, isLocal: true, speaking: false, micMuted: false, deafened: false, mobile: IS_MOBILE_DEVICE }]
            : []),
        ];

  return {
    name,
    me,
    updateMe,
    logout: () => {
      voice.leave();
      logout();
    },
    theme,
    themePref,
    setTheme,
    glassUi,
    setGlassUi,
    liveBg,
    setLiveBg,
    bgGlows,
    setBgGlows,
    glassChat,
    glassChatPref,
    setGlassChat,
    glassVoice,
    glassVoicePref,
    setGlassVoice,
    chatPattern,
    setChatPattern,
    status,
    setStatus,
    statusOf,
    voice,
    servers,
    server,
    serverById,
    serverId,
    serverUnread,
    setServerId,
    textChannel,
    voiceChannel,
    members,
    membersOnline,
    lastSeenOf,
    membersReady,
    membersOffline,
    inVoiceHere,
    joinVoice,
    general,
    lobby,
    voiceUsers,
    voiceSource,
    toast,
    notify: show as (text: string, kind?: ToastKind) => void,
    connBanner,
  };
}

export type AppState = ReturnType<typeof useAppState>;
