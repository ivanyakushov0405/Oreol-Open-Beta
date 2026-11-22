import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChat } from '../features/chat/useChat';
import { IS_MOBILE_DEVICE, savedVoice, useVoice, useVoiceRoster, type VoicePeer } from '../features/voice/useVoice';
import { api, putUser, refreshUsers, type Me, type Member } from '../shared/api';
import type { Server, ServerId, Status } from '../shared/model';
import { useToast, type ToastKind } from '../shared/ui/Toast';

export type Theme = 'dark' | 'light';
/** Выбор в настройках: «Как в системе» (по умолчанию) или конкретная тема. */
export type ThemePref = 'system' | Theme;

const SYSTEM_LIGHT = '(prefers-color-scheme: light)';
export const systemTheme = (): Theme => (window.matchMedia(SYSTEM_LIGHT).matches ? 'light' : 'dark');

/** Тема системы; меняется вместе с ней. */
export function useSystemTheme() {
  const [t, setT] = useState<Theme>(systemTheme);
  useEffect(() => {
    const mq = window.matchMedia(SYSTEM_LIGHT);
    const on = () => setT(mq.matches ? 'light' : 'dark');
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return t;
}

/** Старый «вход по имени» — ключ чистим, теперь вход по email и паролю. */
/** Смена темы или прозрачности — плавно: на полсекунды включаем переходы фона, размытия и кромок у поверхностей
 *  (иначе размытый цвет панелей и меню прыгал разом, и казалось, что резко меняется тор за ними). */
export function animateSurfaces() {
  const html = document.documentElement;
  // тему меняет «разлив» (View Transition) — он сам анимирует смену; свои переходы поверх него давали второе мигание
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
/** Статус раньше хранился локально — теперь он на сервере, старый ключ чистим. */
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
    /* хранилище недоступно */
  }
}

export function useIsMobile() {
  const q = '(max-width: 768px)';
  const [m, setM] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setM(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return m;
}

/** Всё общее состояние приложения: имя, чаты, голос, настройки внешнего вида. */
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
  // Справочник профилей (аватары, фоны, отображаемые имена) — при входе и раз в 30 с
  useEffect(() => {
    putUser(me);
    void refreshUsers();
    const id = window.setInterval(() => void refreshUsers(), 30000);
    return () => window.clearInterval(id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  /** Сохранить свой обновлённый профиль (после правок в настройках). */
  const updateMe = (u: Me) => {
    setMe(u);
    putUser(u);
  };
  // Внешний вид. «Прозрачность интерфейса» — главный переключатель: без неё панели непрозрачные,
  // а прозрачный чат и прозрачный войс (её подпункты) выключаются вместе с ней.
  // По умолчанию прозрачность выключена — включается в «Внешнем виде»
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
  // Живой фон (тор и свечения) — отдельно от прозрачности; без него — спокойный однотонный фон
  // По умолчанию выключен — включается в «Внешнем виде»
  const [liveBg, setLiveBgState] = useState(() => lsGet(LS_LIVE_BG) === '1');
  const setLiveBg = (v: boolean) => {
    setLiveBgState(v);
    lsSet(LS_LIVE_BG, v ? '1' : '0');
  };
  // Свечения по краям фона — подпункт живого фона, по умолчанию выключены
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
    // смена режима — плавно: на полсекунды включаем переходы фона/размытия у стеклянных поверхностей
    if (d.glass && d.glass !== next) animateSurfaces();
    d.glass = next;
    d.pattern = chatPattern ? 'on' : 'off';
    d.backdrop = liveBg ? 'on' : 'off';
    d.glows = bgGlows ? 'on' : 'off';
  }, [glassUi, chatPattern, liveBg, bgGlows]);
  // Серверы — те, где пользователь участник (с бэкенда). Выбранный запоминаем локально.
  const serverById = useCallback((id: string | null | undefined) => servers.find((s) => s.id === id), [servers]);
  const [serverId, setServerIdState] = useState<ServerId>(() => (serverById(lsGet(LS_SERVER)) ?? servers[0]).id);
  const setServerId = (id: ServerId) => {
    setServerIdState(id);
    lsSet(LS_SERVER, id);
  };
  const server = serverById(serverId) ?? servers[0];
  /** Каналы сервера: чат текстового канала и чат голосового идут каждый в свою комнату на бэкенде. */
  const textChannel = server.channels.find((c) => c.kind === 'text') ?? null;
  const voiceChannel = server.channels.find((c) => c.kind === 'voice') ?? null;
  /** Свой статус хранится на сервере и рассылается остальным; offline — «невидимый». */
  const [status, setStatusState] = useState<Status>(me.status ?? 'online');
  useEffect(() => lsSet(LS_STATUS, null), []);
  const voice = useVoice(name);
  const general = useChat(textChannel?.room ?? null, name);
  const lobby = useChat(voiceChannel?.room ?? null, name);
  // Участники сервера и их статусы: список — из /api/servers/{id}/members, статусы — живые из WebSocket
  const statuses = useMemo(() => ({ ...lobby.statuses, ...general.statuses }), [general.statuses, lobby.statuses]);
  // Списки участников по серверам: при переключении сразу показываем последний известный список,
  // а не пустой (иначе «n в сети» на долю секунды показывает 0 и панель участников моргает)
  const memberCache = useRef(new Map<string, Member[]>());
  const [memberRows, setMemberRows] = useState<Member[]>([]);
  const loadMembers = useCallback(async () => {
    try {
      const r = await api<{ members: Member[] }>(`/api/servers/${encodeURIComponent(serverId)}/members`);
      r.members.forEach(putUser);
      memberCache.current.set(serverId, r.members);
      setMemberRows(r.members);
    } catch {
      /* сеть — попробуем при следующем обновлении */
    }
  }, [serverId]);
  useEffect(() => {
    setMemberRows(memberCache.current.get(serverId) ?? []);
    void loadMembers();
    const id = window.setInterval(() => void loadMembers(), 30000);
    return () => window.clearInterval(id);
  }, [loadMembers]);
  // Подключился кто-то, кого ещё нет в списке (например, только что зарегистрировался) — перечитываем
  useEffect(() => {
    if (memberRows.length && Object.keys(statuses).some((n) => !memberRows.some((m) => m.username === n))) void loadMembers();
  }, [statuses]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Видимый статус участника. Свой — выбранный (у «невидимого» это offline). */
  const statusOf = useCallback((n: string): Status => (n === name ? status : statuses[n] ?? 'offline'), [name, status, statuses]);
  const members = useMemo(() => memberRows.map((m) => ({ ...m, status: statusOf(m.username) })), [memberRows, statusOf]);
  const membersOnline = members.filter((m) => m.status !== 'offline');
  const membersOffline = members.filter((m) => m.status === 'offline');
  /** Список участников этого сервера уже загружался хоть раз (до этого число «в сети» не показываем). */
  const membersReady = memberCache.current.has(serverId);
  /** Мы в голосе именно этого сервера. */
  const inVoiceHere = voice.state !== 'idle' && voice.server === serverId;
  const roster = useVoiceRoster(!(inVoiceHere && voice.state === 'connected'), serverId);
  /** Зайти в голос текущего сервера (если уже в голосе другого — перейти). */
  const joinVoice = () => {
    if (!inVoiceHere) void voice.join(serverId);
  };
  const { toast, show } = useToast();
  // После перезагрузки возвращаемся в голос, где были (если всё ещё участник этого сервера)
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
      show('Не удалось сменить статус', 'error');
    });
  };

  useEffect(() => {
    if (voice.error) {
      show(voice.error, 'error');
      voice.clearError();
    }
  }, [voice.error, show, voice]);

  // Связь с сервером: чат текущего канала держит WebSocket. Плашку показываем, только если связь была и пропала,
  // а при восстановлении — зелёный тост.
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
  useEffect(() => {
    if (general.connected) {
      if (lost) show('Соединение восстановлено', 'success');
      everConnected.current = true;
      setLost(false);
      return;
    }
    if (!everConnected.current) return;
    // Короткие обрывы (смена канала, перезапуск сокета) не показываем
    const id = window.setTimeout(() => setLost(true), 1500);
    return () => window.clearTimeout(id);
  }, [general.connected]); // eslint-disable-line react-hooks/exhaustive-deps
  const connBanner = !online
    ? 'Нет подключения к интернету'
    : lost
      ? 'Нет связи с сервером — переподключаемся…'
      : voice.reconnecting
        ? 'Голосовой канал: переподключаемся…'
        : null;

  // Кто в «Лобби» текущего сервера: если мы в нём — из LiveKit, иначе опрашиваем бэкенд.
  const voiceSource: 'live' | 'roster' = inVoiceHere && voice.state === 'connected' ? 'live' : 'roster';
  const voiceUsers: VoicePeer[] =
    voiceSource === 'live'
      ? voice.peers
      : [
          ...roster.map((r) => ({ identity: r.identity, isLocal: r.identity === name, speaking: false, micMuted: r.isMuted, deafened: Boolean(r.deafened), camOn: Boolean(r.camera), screenOn: Boolean(r.screen), mobile: Boolean(r.mobile) })),
          // пока переподключаемся (например, после перезагрузки) — себя в канале показываем сразу
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
    setServerId,
    textChannel,
    voiceChannel,
    members,
    membersOnline,
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
