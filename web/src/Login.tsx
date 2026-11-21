import { useLayoutEffect, useRef, useState } from 'react';
import { HaloMark, Wordmark } from './icons';
import { NAME_RE, handleOf, normalizeName } from './mock';
import { ApiError, api, type Me } from './auth';

type Mode = 'login' | 'signup';
type Fields = Record<string, string>;

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;
const MIN_PASSWORD = 8;

/** Подсказка, почему имя пользователя не подходит (то же правило, что на сервере). */
function usernameError(name: string) {
  if (!name) return 'Введите имя пользователя';
  if (/[^\x00-\x7F]/.test(name)) return 'Только латинские буквы';
  if (name.length < 2) return 'Минимум 2 символа';
  if (!/^[A-Za-z]/.test(name)) return 'Должно начинаться с буквы';
  if (!NAME_RE.test(name)) return 'Допустимы буквы, цифры, пробел, точка, дефис и _';
  return '';
}

/**
 * Экран входа по макетам «Desktop · Sign in / Sign up».
 * Мини-регистрация для своих: email + пароль, без подтверждения почты кодом.
 */
export function Login({ onLogin }: { onLogin: (token: string, user: Me) => void }) {
  const [mode, setMode] = useState<Mode>('login');
  const [busy, setBusy] = useState(false);

  // Вход
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loginErr, setLoginErr] = useState('');

  // Регистрация
  const [suEmail, setSuEmail] = useState('');
  const [suDisplay, setSuDisplay] = useState('');
  const [suUserRaw, setSuUserRaw] = useState('');
  const [suPassword, setSuPassword] = useState('');
  const [suErrors, setSuErrors] = useState<Fields>({});
  const [suCommon, setSuCommon] = useState('');
  const suUser = normalizeName(suUserRaw);

  // Высота карточки плавно подстраивается под активную вкладку.
  const panes = useRef<HTMLDivElement>(null);
  const loginRef = useRef<HTMLDivElement>(null);
  const signupRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number>();
  useLayoutEffect(() => {
    const el = (mode === 'login' ? loginRef : signupRef).current;
    if (!el) return;
    const update = () => setHeight(el.offsetHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [mode]);

  const switchTo = (m: Mode) => {
    if (m === mode) return;
    setMode(m);
    // Фокус в первое поле новой вкладки после анимации.
    window.setTimeout(() => {
      (m === 'login' ? loginRef : signupRef).current?.querySelector('input')?.focus({ preventScroll: true });
    }, 260);
  };

  const doLogin = async () => {
    if (!EMAIL_RE.test(email.trim())) return setLoginErr('Введите корректный email');
    if (!password) return setLoginErr('Введите пароль');
    setBusy(true);
    setLoginErr('');
    try {
      const r = await api<{ token: string; user: Me }>('/api/auth/login', { body: { email: email.trim(), password } });
      onLogin(r.token, r.user);
    } catch (e) {
      setLoginErr(e instanceof ApiError ? e.message : 'Не удалось войти');
    } finally {
      setBusy(false);
    }
  };

  const doSignup = async () => {
    const errs: Fields = {};
    if (!EMAIL_RE.test(suEmail.trim())) errs.email = 'Введите корректный email';
    const ue = usernameError(suUser);
    if (ue) errs.username = ue;
    if (suPassword.length < MIN_PASSWORD) errs.password = `Минимум ${MIN_PASSWORD} символов`;
    setSuErrors(errs);
    setSuCommon('');
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      const r = await api<{ token: string; user: Me }>('/api/auth/register', {
        body: { email: suEmail.trim(), displayName: suDisplay.trim() || suUser, username: suUser, password: suPassword },
      });
      onLogin(r.token, r.user);
    } catch (e) {
      if (e instanceof ApiError && Object.keys(e.fields).length) setSuErrors(e.fields);
      else setSuCommon(e instanceof Error ? e.message : 'Не удалось создать аккаунт');
    } finally {
      setBusy(false);
    }
  };

  const tabL = mode === 'login' ? 0 : -1;
  const tabS = mode === 'signup' ? 0 : -1;

  return (
    <>
      <div className={'signin mode-' + mode}>
        <div className="signin-hero">
          <div className="brand-card">
            <HaloMark size={104} />
            <Wordmark height={60} />
          </div>
          <div className="hero-titles">
            <h1 className={mode === 'login' ? 'on' : ''} aria-hidden={mode !== 'login'}>
              Войти в Ореол
            </h1>
            <h1 className={mode === 'signup' ? 'on' : ''} aria-hidden={mode !== 'signup'}>
              Ваш новый ореол друзей
            </h1>
          </div>
          <p>Соберите свой сервер и позовите друзей: текстовые и голосовые каналы, личные сообщения и звонки — в одном приложении.</p>
        </div>

        <div className="auth-card">
          <div className={'mode-switch ' + mode} role="tablist">
            <button type="button" role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'on' : ''} onClick={() => switchTo('login')}>
              Вход
            </button>
            <button type="button" role="tab" aria-selected={mode === 'signup'} className={mode === 'signup' ? 'on' : ''} onClick={() => switchTo('signup')}>
              Регистрация
            </button>
          </div>

          <div className="auth-panes" ref={panes} style={height ? { height } : undefined}>
            {/* ---------- Вход ---------- */}
            <div ref={loginRef} className={'auth-pane pane-login' + (mode === 'login' ? ' active' : '')} aria-hidden={mode !== 'login'}>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!busy) void doLogin();
                }}
              >
                <div className="auth-head">
                  <h2>Войти в аккаунт</h2>
                  <p className="sub">Ваши серверы и переписки ждут на месте</p>
                </div>
                <label className="auth-field">
                  <span className="field-label">Email</span>
                  <input
                    className={'input' + (loginErr ? ' invalid' : '')}
                    type="email"
                    autoFocus
                    autoComplete="email"
                    value={email}
                    placeholder="you@example.com"
                    tabIndex={tabL}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </label>
                <label className="auth-field">
                  <span className="field-label">Пароль</span>
                  <input
                    className={'input' + (loginErr ? ' invalid' : '')}
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    placeholder="Пароль"
                    tabIndex={tabL}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  {loginErr && <span className="field-hint error">{loginErr}</span>}
                </label>
                <button className="btn btn-primary auth-submit" type="submit" disabled={busy} tabIndex={tabL}>
                  {busy && mode === 'login' ? 'Входим…' : 'Войти'}
                </button>
                <div className="auth-foot">
                  Нет аккаунта?{' '}
                  <button type="button" className="link" tabIndex={tabL} onClick={() => switchTo('signup')}>
                    Зарегистрироваться
                  </button>
                </div>
              </form>
            </div>

            {/* ---------- Регистрация ---------- */}
            <div ref={signupRef} className={'auth-pane pane-signup' + (mode === 'signup' ? ' active' : '')} aria-hidden={mode !== 'signup'}>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!busy) void doSignup();
                }}
              >
                <div className="auth-head">
                  <h2>Создать аккаунт</h2>
                  <p className="sub">Это займёт меньше минуты</p>
                </div>
                <label className="auth-field stagger" style={{ ['--i' as string]: 0 }}>
                  <span className="field-label">Email</span>
                  <input
                    className={'input' + (suErrors.email ? ' invalid' : '')}
                    type="email"
                    autoComplete="email"
                    value={suEmail}
                    placeholder="you@example.com"
                    tabIndex={tabS}
                    onChange={(e) => setSuEmail(e.target.value)}
                  />
                  {suErrors.email && <span className="field-hint error">{suErrors.email}</span>}
                </label>
                <label className="auth-field stagger" style={{ ['--i' as string]: 1 }}>
                  <span className="field-label">Отображаемое имя</span>
                  <input
                    className="input"
                    autoComplete="nickname"
                    value={suDisplay}
                    maxLength={32}
                    placeholder="Как вас будут видеть другие"
                    tabIndex={tabS}
                    onChange={(e) => setSuDisplay(e.target.value)}
                  />
                </label>
                <label className="auth-field stagger" style={{ ['--i' as string]: 2 }}>
                  <span className="field-label">Имя пользователя (латиницей)</span>
                  <input
                    className={'input' + (suErrors.username ? ' invalid' : '')}
                    autoComplete="username"
                    value={suUserRaw}
                    maxLength={32}
                    placeholder="Например, Alex"
                    tabIndex={tabS}
                    onChange={(e) => setSuUserRaw(e.target.value)}
                  />
                  <span className={'field-hint' + (suErrors.username ? ' error' : '')}>
                    {suErrors.username ||
                      (suUser && !usernameError(suUser) ? (
                        <>
                          Юзернейм: <b>{handleOf(suUser)}</b>
                        </>
                      ) : (
                        'Под ним вас видно в чате и в голосе'
                      ))}
                  </span>
                </label>
                <label className="auth-field stagger" style={{ ['--i' as string]: 3 }}>
                  <span className="field-label">Пароль</span>
                  <input
                    className={'input' + (suErrors.password ? ' invalid' : '')}
                    type="password"
                    autoComplete="new-password"
                    value={suPassword}
                    placeholder={`Минимум ${MIN_PASSWORD} символов`}
                    tabIndex={tabS}
                    onChange={(e) => setSuPassword(e.target.value)}
                  />
                  {suErrors.password && <span className="field-hint error">{suErrors.password}</span>}
                </label>
                {suCommon && <span className="field-hint error">{suCommon}</span>}
                <button className="btn btn-primary auth-submit stagger" style={{ ['--i' as string]: 4 }} type="submit" disabled={busy} tabIndex={tabS}>
                  {busy && mode === 'signup' ? 'Создаём…' : 'Создать аккаунт'}
                </button>
                <div className="auth-foot">
                  Уже есть аккаунт?{' '}
                  <button type="button" className="link" tabIndex={tabS} onClick={() => switchTo('login')}>
                    Войти
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
