import { useCallback, useEffect, useState } from 'react';
import { Login } from '../features/auth/Login';
import { UserMenuHost } from '../features/members/userMenu';
import { MessageAlerts } from '../features/notifications/notifications';
import { ProfileHost } from '../features/profile/profile';
import { Desktop } from '../layout/desktop/Desktop';
import { Mobile } from '../layout/mobile/Mobile';
import { api, clearUsers, getToken, SESSION_EXPIRED, setToken, type Me } from '../shared/api';
import type { Server } from '../shared/model';
import { ConnBanner } from '../shared/ui/Toast';
import { Backdrop } from './Backdrop';
import { animateSurfaces, LS_NAME, LS_THEME, lsGet, lsSet, useAppState, useIsMobile, type Theme } from './useAppState';

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
  return (
    <>
      {mobile ? <Mobile app={app} /> : <Desktop app={app} />}
      <ProfileHost app={app} />
      <UserMenuHost app={app} />
      <MessageAlerts app={app} />
      {app.connBanner && <ConnBanner text={app.connBanner} tone={app.connBanner.startsWith('Нет') ? 'error' : 'warn'} />}
      {app.toast}
    </>
  );
}

/** Полноэкранная ошибка загрузки: бэкенд недоступен или ответил ошибкой. */
function ErrorScreen({ text, retry, onLogout }: { text: string; retry: () => void; onLogout?: () => void }) {
  return (
    <>
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

/** Фон — один на всё приложение и не пересоздаётся при смене экранов (загрузка → вход → приложение):
 *  раньше у каждого экрана был свой, и при переходах свечения и тор появлялись заново — «мигали». */
export default function App() {
  const mobile = useIsMobile();
  return (
    <>
      <Backdrop mobile={mobile} />
      <AppScreens />
    </>
  );
}

function AppScreens() {
  const [me, setMe] = useState<Me | null>(null);
  // Пока проверяем сохранённую сессию, экран входа не мигает
  const [checking, setChecking] = useState(() => !!getToken());
  /** Бэкенд недоступен при старте — экран ошибки с повтором вместо экрана входа. */
  const [bootError, setBootError] = useState<string | null>(null);
  const [bootTry, setBootTry] = useState(0);
  // Первые мгновения после загрузки — без анимаций и переходов: интерфейс встаёт сразу в итоговом виде.
  // Снимаем на любом экране, включая вход: раньше класс снимал только интерфейс после входа,
  // и на экране входа переходы «Вход ⇄ Регистрация» не работали.
  useEffect(() => {
    const id = window.setTimeout(() => document.documentElement.classList.remove('boot'), 700);
    return () => window.clearTimeout(id);
  }, []);
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
    const d = document.documentElement.dataset;
    if (d.theme && d.theme !== theme) animateSurfaces();
    d.theme = theme;
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

  if (checking) return null;
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
  if (!servers) return null;
  if (!servers.length) {
    return (
      <>
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
