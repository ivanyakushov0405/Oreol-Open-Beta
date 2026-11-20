import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Login } from './Login';
import { Desktop } from './Desktop';
import { Mobile } from './Mobile';
import { useChat } from './useChat';
import { IS_MOBILE_DEVICE, savedVoice, useVoice, useVoiceRoster, type VoicePeer } from './useVoice';
import { ConnBanner, useToast, type ToastKind } from './ui';
import { Backdrop } from './Backdrop';
import type { Server, ServerId, Status } from './mock';
import { api, clearUsers, getToken, putUser, refreshUsers, SESSION_EXPIRED, setToken, type Me, type Member } from './auth';

export type Theme = 'dark' | 'light';

/** Старый «вход по имени» — ключ чистим, теперь вход по email и паролю. */
const LS_NAME = 'oreol.name';
const LS_THEME = 'oreol.theme';
const LS_GLASS = 'oreol.glassChat';
const LS_GLASS_VOICE = 'oreol.glassVoice';
const LS_GLASS_UI = 'oreol.glassUi';
const LS_PATTERN = 'oreol.chatPattern';
const LS_SERVER = 'oreol.server';
/** Статус раньше хранился локально — теперь он на сервере, старый ключ чистим. */
const LS_STATUS = 'oreol.status';

function lsGet(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function lsSet(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* хранилище недоступно */
  }
}

function useIsMobile() {
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
function useAppState(
  me: Me,
  servers: Server[],
  setMe: (u: Me) => void,
  logout: () => void,
  theme: Theme,
  setTheme: (t: Theme) => void,
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
  const [glassUi, setGlassUiState] = useState(() => lsGet(LS_GLASS_UI) !== '0');
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
  const glassChat = glassUi && glassChatPref;
  const glassVoice = glassUi && glassVoicePref;
  useEffect(() => {
    const d = document.documentElement.dataset;
    d.glass = glassUi ? 'on' : 'off';
    d.pattern = chatPattern ? 'on' : 'off';
  }, [glassUi, chatPattern]);
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
          ...roster.map((r) => ({ identity: r.identity, isLocal: r.identity === name, speaking: false, micMuted: r.isMuted, deafened: false, mobile: Boolean(r.mobile) })),
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
    setTheme,
    glassUi,
    setGlassUi,
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

function Shell(props: {
  me: Me;
  servers: Server[];
  setMe: (u: Me) => void;
  logout: () => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
}) {
  const app = useAppState(props.me, props.servers, props.setMe, props.logout, props.theme, props.setTheme);
  const mobile = useIsMobile();
  // Первые мгновения после загрузки — без анимаций и переходов: интерфейс встаёт сразу в итоговом виде
  useEffect(() => {
    const id = window.setTimeout(() => document.documentElement.classList.remove('boot'), 700);
    return () => window.clearTimeout(id);
  }, []);
  return (
    <>
      <Backdrop mobile={mobile} />
      {mobile ? <Mobile app={app} /> : <Desktop app={app} />}
      {app.connBanner && <ConnBanner text={app.connBanner} tone={app.connBanner.startsWith('Нет') ? 'error' : 'warn'} />}
      {app.toast}
    </>
  );
}

/** Полноэкранная ошибка загрузки: бэкенд недоступен или ответил ошибкой. */
function ErrorScreen({ text, retry, onLogout }: { text: string; retry: () => void; onLogout?: () => void }) {
  return (
    <>
      <Backdrop />
      <div className="empty-state error-screen" role="alert">
        <b>Не удалось загрузить Ореол</b>
        <span>{text}</span>
        <div className="row">
          <button className="btn btn-primary" onClick={retry}>
            Повторить
          </button>
          {onLogout && (
            <button className="btn btn-secondary" onClick={onLogout}>
              Выйти
            </button>
          )}
        </div>
      </div>
    </>
  );
}

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  // Пока проверяем сохранённую сессию, экран входа не мигает
  const [checking, setChecking] = useState(() => !!getToken());
  /** Бэкенд недоступен при старте — экран ошибки с повтором вместо экрана входа. */
  const [bootError, setBootError] = useState<string | null>(null);
  const [bootTry, setBootTry] = useState(0);
  useEffect(() => {
    lsSet(LS_NAME, null);
    if (!getToken()) return;
    api<{ user: Me }>('/api/auth/me')
      .then((r) => setMe(r.user))
      .catch((e) => {
        if (e?.status === 401) setToken(null);
        else setBootError(e?.message || 'Не удалось связаться с сервером');
      })
      .finally(() => setChecking(false));
  }, [bootTry]);
  // Сервер перестал принимать токен (сессия завершена с другого устройства, аккаунт удалён) — на экран входа
  useEffect(() => {
    const expired = () => {
      setToken(null);
      clearUsers();
      setMe(null);
    };
    window.addEventListener(SESSION_EXPIRED, expired);
    return () => window.removeEventListener(SESSION_EXPIRED, expired);
  }, []);
  // Серверы, где пользователь участник, — после входа
  const [servers, setServers] = useState<Server[] | null>(null);
  const [serversError, setServersError] = useState<string | null>(null);
  const [serversTry, setServersTry] = useState(0);
  const meId = me?.id;
  useEffect(() => {
    setServers(null);
    setServersError(null);
    if (!meId) return;
    api<{ servers: Server[] }>('/api/servers')
      .then((r) => setServers(r.servers))
      .catch((e) => setServersError(e?.message || 'Не удалось загрузить серверы'));
  }, [meId, serversTry]);
  const [theme, setThemeState] = useState<Theme>(() => (lsGet(LS_THEME) === 'light' ? 'light' : 'dark'));

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    lsSet(LS_THEME, t);
  }, []);

  const login = (token: string, user: Me) => {
    setToken(token);
    setMe(user);
  };
  const logout = () => {
    void api('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    setToken(null);
    clearUsers();
    setMe(null);
  };

  if (checking) return <Backdrop />;
  if (bootError && !me) {
    return (
      <ErrorScreen
        text={bootError}
        retry={() => {
          setBootError(null);
          setChecking(true);
          setBootTry((n) => n + 1);
        }}
      />
    );
  }
  if (!me) return <Login onLogin={login} />;
  if (serversError) return <ErrorScreen text={serversError} retry={() => setServersTry((n) => n + 1)} onLogout={logout} />;
  if (!servers) return <Backdrop />;
  if (!servers.length) {
    return (
      <>
        <Backdrop />
        <div className="empty-state" style={{ position: 'fixed', inset: 0, justifyContent: 'center' }}>
          <b>Вы пока не состоите ни в одном сервере</b>
          <button className="btn btn-secondary" onClick={logout} style={{ marginTop: 12 }}>
            Выйти
          </button>
        </div>
      </>
    );
  }
  return <Shell key={me.id} me={me} servers={servers} setMe={setMe} logout={logout} theme={theme} setTheme={setTheme} />;
}
