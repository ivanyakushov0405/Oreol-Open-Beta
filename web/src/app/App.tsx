import { AppSkeleton } from '../shared/ui/Skeleton';
import { useCallback, useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { Login } from '../features/auth/Login';
import { UserMenuHost } from '../features/members/userMenu';
import { MessageAlerts } from '../features/notifications/notifications';
import { ProfileHost } from '../features/profile/profile';
import { Desktop } from '../layout/desktop/Desktop';
import { Mobile } from '../layout/mobile/Mobile';
import { api, clearUsers, hasSession, SESSION_EXPIRED, setSession, type Me } from '../shared/api';
import type { Server } from '../shared/model';
import { ConnBanner } from '../shared/ui/Toast';
import { Backdrop } from './Backdrop';
import { animateSurfaces, LS_NAME, LS_THEME, lsGet, lsSet, useAppState, useIsMobile, useSystemTheme, type Theme, type ThemePref } from './useAppState';
import { lang, onLang, t } from '../shared/i18n';

function Shell(props: {
  me: Me;
  servers: Server[];
  setMe: (u: Me) => void;
  logout: () => void;
  theme: Theme;
  themePref: ThemePref;
  setTheme: (t: ThemePref) => void;
}) {
  const app = useAppState(props.me, props.servers, props.setMe, props.logout, props.theme, props.themePref, props.setTheme);
  const mobile = useIsMobile();
  // A language switch re-renders everything below in place, so every label is read again.
  const [, setShownLang] = useState(lang);
  useEffect(() => onLang(() => flushSync(() => setShownLang(lang))), []);
  return (
    <>
      {mobile ? <Mobile app={app} /> : <Desktop app={app} />}
      <ProfileHost app={app} />
      <UserMenuHost app={app} />
      <MessageAlerts app={app} />
      {app.connBanner && <ConnBanner text={app.connBanner} tone={app.connBanner.startsWith(t('Нет')) ? 'error' : 'warn'} />}
      {app.toast}
    </>
  );
}

function ErrorScreen({ text, retry, onLogout }: { text: string; retry: () => void; onLogout?: () => void }) {
  return (
    <>
      <div className="empty-state error-screen" role="alert">
        <b>{t('Не удалось загрузить Ореол')}</b>
        <span>{text}</span>
        <div className="row">
          <button className="btn btn-primary" onClick={retry}>
            {t('Повторить')}
          </button>
          {onLogout && (
            <button className="btn btn-secondary" onClick={onLogout}>
              {t('Выйти')}
            </button>
          )}
        </div>
      </div>
    </>
  );
}

/** One backdrop for the whole app: remounting it per screen restarted the glows and made them flicker. */
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
  const mobile = useIsMobile();
  const [me, setMe] = useState<Me | null>(null);
  // Hold the login screen while the stored session is being checked, so it does not flash.
  const [checking, setChecking] = useState(() => hasSession());
  const [bootError, setBootError] = useState<string | null>(null);
  const [bootTry, setBootTry] = useState(0);
  // Disable animations for the first moments after load so the UI appears in its final state.
  useEffect(() => {
    const id = window.setTimeout(() => document.documentElement.classList.remove('boot'), 700);
    return () => window.clearTimeout(id);
  }, []);
  // A file dropped outside a chat must not make the browser open it in place of the app.
  useEffect(() => {
    const stop = (e: DragEvent) => e.dataTransfer?.types.includes('Files') && e.preventDefault();
    window.addEventListener('dragover', stop);
    window.addEventListener('drop', stop);
    return () => {
      window.removeEventListener('dragover', stop);
      window.removeEventListener('drop', stop);
    };
  }, []);
  useEffect(() => {
    lsSet(LS_NAME, null);
    if (!hasSession()) return;
    api<{ user: Me }>('/api/auth/me')
      .then((r) => {
        setSession(true);
        setMe(r.user);
      })
      .catch((e) => {
        if (e?.status === 401) setSession(false);
        else setBootError(e?.message || t('Не удалось связаться с сервером'));
      })
      .finally(() => setChecking(false));
  }, [bootTry]);
  // The server rejected the session (signed out elsewhere, account deleted): back to the login screen.
  useEffect(() => {
    const expired = () => {
      setSession(false);
      clearUsers();
      setMe(null);
    };
    window.addEventListener(SESSION_EXPIRED, expired);
    return () => window.removeEventListener(SESSION_EXPIRED, expired);
  }, []);
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
      .catch((e) => setServersError(e?.message || t('Не удалось загрузить серверы')));
  }, [meId, serversTry]);
  const sysTheme = useSystemTheme();
  const [themePref, setThemePref] = useState<ThemePref>(() => {
    const v = lsGet(LS_THEME);
    return v === 'light' || v === 'dark' ? v : 'system';
  });
  // While the session is being checked, use the user's theme already, otherwise the system theme flashes on reload.
  const theme: Theme = (me || checking) && themePref !== 'system' ? themePref : sysTheme;

  useEffect(() => {
    const d = document.documentElement.dataset;
    if (d.theme && d.theme !== theme) animateSurfaces();
    d.theme = theme;
  }, [theme]);

  // The login screen always has glass and the live backdrop; after login useAppState applies the user's settings.
  useEffect(() => {
    if (me || checking) return;
    const d = document.documentElement.dataset;
    d.glass = 'on';
    d.backdrop = 'on';
    d.glows = 'off';
  }, [me, checking]);

  const setTheme = useCallback((t: ThemePref) => {
    setThemePref(t);
    lsSet(LS_THEME, t === 'system' ? null : t);
  }, []);

  const login = (user: Me) => {
    setSession(true);
    setMe(user);
  };
  const logout = () => {
    void api('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    setSession(false);
    clearUsers();
    setMe(null);
  };

  if (checking) return <AppSkeleton mobile={mobile} />;
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
  if (!servers) return <AppSkeleton mobile={mobile} />;
  if (!servers.length) {
    return (
      <>
        <div className="empty-state" style={{ position: 'fixed', inset: 0, justifyContent: 'center' }}>
          <b>{t('Вы пока не состоите ни в одном сервере')}</b>
          <button className="btn btn-secondary" onClick={logout} style={{ marginTop: 12 }}>
            {t('Выйти')}
          </button>
        </div>
      </>
    );
  }
  return <Shell key={me.id} me={me} servers={servers} setMe={setMe} logout={logout} theme={theme} themePref={themePref} setTheme={setTheme} />;
}
