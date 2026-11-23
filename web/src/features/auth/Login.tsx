import { useLayoutEffect, useRef, useState } from 'react';
import { api, ApiError, type Me } from '../../shared/api';
import { HaloMark, Wordmark } from '../../shared/icons';
import { handleOf, NAME_RE, normalizeName, reservedName } from '../../shared/model';
import { t } from '../../shared/i18n';

type Mode = 'login' | 'signup';
type Fields = Record<string, string>;

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;
const MIN_PASSWORD = 8;

function usernameError(name: string) {
  if (!name) return t('Введите имя пользователя');
  if (/[^\x00-\x7F]/.test(name)) return t('Только латинские буквы');
  if (name.length < 2) return t('Минимум 2 символа');
  if (!/^[A-Za-z]/.test(name)) return t('Должно начинаться с буквы');
  if (!NAME_RE.test(name)) return t('Допустимы буквы, цифры, пробел, точка, дефис и _');
  if (reservedName(name)) return t('Это имя зарезервировано, выберите другое');
  return '';
}

export function Login({ onLogin }: { onLogin: (user: Me) => void }) {
  const [mode, setMode] = useState<Mode>('login');
  const [busy, setBusy] = useState(false);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loginErr, setLoginErr] = useState('');

  const [suEmail, setSuEmail] = useState('');
  const [suDisplay, setSuDisplay] = useState('');
  const [suUserRaw, setSuUserRaw] = useState('');
  const [suPassword, setSuPassword] = useState('');
  const [suErrors, setSuErrors] = useState<Fields>({});
  const [suCommon, setSuCommon] = useState('');
  const suUser = normalizeName(suUserRaw);

  // The card height follows the active tab.
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
    window.setTimeout(() => {
      (m === 'login' ? loginRef : signupRef).current?.querySelector('input')?.focus({ preventScroll: true });
    }, 260);
  };

  const doLogin = async () => {
    if (!EMAIL_RE.test(email.trim())) return setLoginErr(t('Введите корректный email'));
    if (!password) return setLoginErr(t('Введите пароль'));
    setBusy(true);
    setLoginErr('');
    try {
      const r = await api<{ user: Me }>('/api/auth/login', { body: { email: email.trim(), password } });
      onLogin(r.user);
    } catch (e) {
      setLoginErr(e instanceof ApiError ? e.message : t('Не удалось войти'));
    } finally {
      setBusy(false);
    }
  };

  const doSignup = async () => {
    const errs: Fields = {};
    if (!EMAIL_RE.test(suEmail.trim())) errs.email = t('Введите корректный email');
    const ue = usernameError(suUser);
    if (ue) errs.username = ue;
    if (suPassword.length < MIN_PASSWORD) errs.password = t('Минимум {0} символов', { 0: MIN_PASSWORD });
    setSuErrors(errs);
    setSuCommon('');
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      const r = await api<{ user: Me }>('/api/auth/register', {
        body: { email: suEmail.trim(), displayName: suDisplay.trim() || suUser, username: suUser, password: suPassword },
      });
      onLogin(r.user);
    } catch (e) {
      if (e instanceof ApiError && Object.keys(e.fields).length) setSuErrors(e.fields);
      else setSuCommon(e instanceof Error ? e.message : t('Не удалось создать аккаунт'));
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
              {t('Войти в Ореол')}
            </h1>
            <h1 className={mode === 'signup' ? 'on' : ''} aria-hidden={mode !== 'signup'}>
              {t('Ваш новый ореол друзей')}
            </h1>
          </div>
          <p>{t('Соберите свой сервер и позовите друзей: текстовые и голосовые каналы, личные сообщения и звонки в одном приложении.')}</p>
        </div>

        <div className="auth-card">
          <div className={'mode-switch ' + mode} role="tablist">
            <button type="button" role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'on' : ''} onClick={() => switchTo('login')}>
              {t('Вход')}
            </button>
            <button type="button" role="tab" aria-selected={mode === 'signup'} className={mode === 'signup' ? 'on' : ''} onClick={() => switchTo('signup')}>
              {t('Регистрация')}
            </button>
          </div>

          <div className="auth-panes" ref={panes} style={height ? { height } : undefined}>
            <div ref={loginRef} className={'auth-pane pane-login' + (mode === 'login' ? ' active' : '')} aria-hidden={mode !== 'login'}>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!busy) void doLogin();
                }}
              >
                <div className="auth-head">
                  <h2>{t('Войти в аккаунт')}</h2>
                  <p className="sub">{t('Ваши серверы и переписки ждут на месте')}</p>
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
                  <span className="field-label">{t('Пароль')}</span>
                  <input
                    className={'input' + (loginErr ? ' invalid' : '')}
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    placeholder={t('Пароль')}
                    tabIndex={tabL}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  {loginErr && <span className="field-hint error">{loginErr}</span>}
                </label>
                <button className="btn btn-primary auth-submit" type="submit" disabled={busy} tabIndex={tabL}>
                  {busy && mode === 'login' ? <span className="btn-spin" role="status" aria-label={t('Входим')} /> : t('Войти')}
                </button>
                <div className="auth-foot">
                  {t('Нет аккаунта?')}{' '}
                  <button type="button" className="link" tabIndex={tabL} onClick={() => switchTo('signup')}>
                    {t('Зарегистрироваться')}
                  </button>
                </div>
              </form>
            </div>

            <div ref={signupRef} className={'auth-pane pane-signup' + (mode === 'signup' ? ' active' : '')} aria-hidden={mode !== 'signup'}>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!busy) void doSignup();
                }}
              >
                <div className="auth-head">
                  <h2>{t('Создать аккаунт')}</h2>
                  <p className="sub">{t('Это займёт меньше минуты')}</p>
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
                  <span className="field-label">{t('Отображаемое имя')}</span>
                  <input
                    className="input"
                    autoComplete="nickname"
                    value={suDisplay}
                    maxLength={32}
                    placeholder={t('Как вас будут видеть другие')}
                    tabIndex={tabS}
                    onChange={(e) => setSuDisplay(e.target.value)}
                  />
                </label>
                <label className="auth-field stagger" style={{ ['--i' as string]: 2 }}>
                  <span className="field-label">{t('Имя пользователя (латиницей)')}</span>
                  <input
                    className={'input' + (suErrors.username ? ' invalid' : '')}
                    autoComplete="username"
                    value={suUserRaw}
                    maxLength={32}
                    placeholder={t('Например, Alex')}
                    tabIndex={tabS}
                    onChange={(e) => setSuUserRaw(e.target.value)}
                  />
                  <span className={'field-hint' + (suErrors.username ? ' error' : '')}>
                    {suErrors.username ||
                      (suUser && !usernameError(suUser) ? (
                        <>
                          {t('Юзернейм: ')}<b>{handleOf(suUser)}</b>
                        </>
                      ) : (
                        t('Под ним вас видно в чате и в голосе')
                      ))}
                  </span>
                </label>
                <label className="auth-field stagger" style={{ ['--i' as string]: 3 }}>
                  <span className="field-label">{t('Пароль')}</span>
                  <input
                    className={'input' + (suErrors.password ? ' invalid' : '')}
                    type="password"
                    autoComplete="new-password"
                    value={suPassword}
                    placeholder={t('Минимум {0} символов', { 0: MIN_PASSWORD })}
                    tabIndex={tabS}
                    onChange={(e) => setSuPassword(e.target.value)}
                  />
                  {suErrors.password && <span className="field-hint error">{suErrors.password}</span>}
                </label>
                {suCommon && <span className="field-hint error">{suCommon}</span>}
                <button className="btn btn-primary auth-submit stagger" style={{ ['--i' as string]: 4 }} type="submit" disabled={busy} tabIndex={tabS}>
                  {busy && mode === 'signup' ? <span className="btn-spin" role="status" aria-label={t('Создаём аккаунт')} /> : t('Создать аккаунт')}
                </button>
                <div className="auth-foot">
                  {t('Уже есть аккаунт?')}{' '}
                  <button type="button" className="link" tabIndex={tabS} onClick={() => switchTo('login')}>
                    {t('Войти')}
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
