import { Icon } from '../../shared/icons';
import { flushSync } from 'react-dom';
import { systemTheme, type AppState, type ThemePref } from '../../app/useAppState';
import { AccountEdit, AccountView } from './AccountSettings';
import { Toggle } from './Toggle';
import { CameraSettings, SoundSettings, VoiceDevices } from './VoiceSettings';
import type { UserSection } from './nav';
import { lang, setLang, t, type Lang } from '../../shared/i18n';

// Each language is named in itself so it can be found from either one.
const LANGS: { id: Lang; label: string; hint: string }[] = [
  // each name in its own language, plus the name in the current interface language when it differs
  { id: 'ru', label: 'Русский', get hint() { return lang === 'ru' ? '' : 'Russian'; } },
  { id: 'en', label: 'English', get hint() { return lang === 'en' ? '' : 'Английский'; } },
];

const THEME_LABEL: Record<ThemePref, string> = { get system() { return t('Как в системе'); }, get dark() { return t('Тёмная'); }, get light() { return t('Светлая'); } };
const THEME_PREVIEW: Record<ThemePref, string> = {
  dark: 'linear-gradient(135deg,#040a14,#0e2238 60%,#2f7bff)',
  light: 'linear-gradient(135deg,#ffffff,#eef4fb 60%,#9fc2ff)',
  system: 'linear-gradient(135deg,#040a14,#0e2238 49.5%,#eef4fb 50.5%,#9fc2ff)',
};

function switchTheme(app: AppState, pref: ThemePref, from: HTMLElement) {
  if (app.themePref === pref) return;
  const t = pref === 'system' ? systemTheme() : pref;
  // The visible theme does not change (e.g. "System" with a dark system and dark selected): no animation.
  if (app.theme === t) {
    app.setTheme(pref);
    return;
  }
  const doc = document as Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void> } };
  // Firefox renders the reveal snapshots without backdrop-filter saturation, so everything dims during the animation
  // and flashes at the end. There the theme changes through plain color transitions.
  if (!doc.startViewTransition || /firefox/i.test(navigator.userAgent)) {
    app.setTheme(pref);
    return;
  }
  const b = from.getBoundingClientRect();
  const x = b.left + b.width / 2;
  const y = b.top + b.height / 2;
  const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  const root = document.documentElement;
  root.dataset.vt = t;
  let applied = false;
  const apply = () => {
    if (applied) return;
    applied = true;
    flushSync(() => app.setTheme(pref));
    root.dataset.theme = t;
  };
  const vt = doc.startViewTransition(apply) as { ready: Promise<void>; finished?: Promise<void>; skipTransition?: () => void };
  // Fallback: if the browser never gives a frame for the transition (background tab), switch immediately.
  window.setTimeout(() => {
    if (applied) return;
    vt.skipTransition?.();
    apply();
    delete root.dataset.vt;
  }, 1200);
  // Soft edge: a radial-gradient mask whose radius is animated (--vt-r is registered in CSS).
  const feather = Math.max(140, r * 0.28);
  root.style.setProperty('--vt-x', `${x}px`);
  root.style.setProperty('--vt-y', `${y}px`);
  root.style.setProperty('--vt-f', `${feather}px`);
  vt.ready.then(() => {
    const a = root.animate({ '--vt-r': ['0px', `${r + feather}px`] } as PropertyIndexedKeyframes, {
      duration: 900,
      easing: 'cubic-bezier(.35, 0, .2, 1)',
      fill: 'forwards',
      pseudoElement: '::view-transition-new(root)',
    });
    vt.finished?.finally(() => {
      a.cancel();
      delete root.dataset.vt;
    });
  }, () => delete root.dataset.vt);
}

export function Soon({ title, text }: { title: string; text?: string }) {
  return (
    <div className="card">
      <h3>{title}</h3>
      <p className="hint" style={{ margin: 0 }}>
        {text ?? t('Скоро будет')}
      </p>
    </div>
  );
}

export function UserSettingsBody({
  app,
  section,
  onSection,
}: {
  app: AppState;
  section: UserSection;
  onSection?: (s: UserSection) => void;
}) {
  const v = app.voice;
  switch (section) {
    case 'account':
    case 'profile':
      return <AccountView app={app} onEdit={() => onSection?.('account-edit')} />;
    case 'account-edit':
      return <AccountEdit app={app} onDone={() => onSection?.('account')} />;
    case 'voice':
      return (
        <>
        <VoiceDevices />
        <div className="card kv">
          <div className="row-between">
            <div>
              <h3>{t('Микрофон')}</h3>
              <p className="hint" style={{ margin: 0 }}>
                {v.state === 'connected' ? t('Вы в «Лобби»') : v.micOn ? t('Включится при входе в голосовой канал') : t('Останется выключенным при входе в канал')}
              </p>
            </div>
            <Toggle on={v.micOn} onChange={() => v.toggleMic()} />
          </div>
          <div className="row-between">
            <div>
              <h3>{t('Звук')}</h3>
              <p className="hint" style={{ margin: 0 }}>
                {t('Выключите, чтобы не слышать собеседников')}
              </p>
            </div>
            <Toggle on={!v.deafened} onChange={() => v.toggleDeafen()} />
          </div>
        </div>
        <CameraSettings />
        <SoundSettings />
        </>
      );
    case 'language':
      return (
        <div className="card">
          <h3>{t('Язык интерфейса')}</h3>
          <p className="hint">{t('Сохраняется на этом устройстве')}</p>
          <div className="lang-list" role="radiogroup" aria-label={t('Язык')}>
            {LANGS.map((l) => (
              <button key={l.id} type="button" role="radio" aria-checked={lang === l.id} className={'lang-opt' + (lang === l.id ? ' on' : '')} onClick={() => setLang(l.id)}>
                <span>
                  <b>{l.label}</b>
                  {l.hint && <small>{l.hint}</small>}
                </span>
                {lang === l.id && <Icon name="check" size={20} />}
              </button>
            ))}
          </div>
        </div>
      );
    case 'appearance':
      return (
        <>
          <div className="card">
            <h3>{t('Тема')}</h3>
            <p className="hint">{t('Сохраняется на этом устройстве')}</p>
            <div className="theme-cards">
              {(['system', 'dark', 'light'] as const).map((t) => (
                <button key={t} className={'theme-card' + (app.themePref === t ? ' on' : '')} onClick={(e) => switchTheme(app, t, e.currentTarget)}>
                  <div className="preview" style={{ background: THEME_PREVIEW[t] }} />
                  {THEME_LABEL[t]}
                </button>
              ))}
            </div>
          </div>
          <div className="card">
            <div className="row-between">
              <div>
                <h3>{t('Прозрачность интерфейса')}</h3>
                <p className="hint" style={{ margin: 0 }}>
                  {t('Стеклянные панели, сквозь которые виден фон')}
                </p>
              </div>
              <Toggle on={app.glassUi} onChange={app.setGlassUi} />
            </div>
            <div className={'sub-settings' + (app.glassUi ? '' : ' off')}>
              <div className="row-between">
                <div>
                  <h4>{t('Прозрачный чат')}</h4>
                  <p className="hint" style={{ margin: 0 }}>
                    {t('Фон текстового чата становится стеклянным')}
                  </p>
                </div>
                <Toggle on={app.glassChat} onChange={app.setGlassChat} disabled={!app.glassUi} />
              </div>
              <div className="row-between">
                <div>
                  <h4>{t('Прозрачный войс')}</h4>
                  <p className="hint" style={{ margin: 0 }}>
                    {t('Фон голосового канала становится стеклянным')}
                  </p>
                </div>
                <Toggle on={app.glassVoice} onChange={app.setGlassVoice} disabled={!app.glassUi} />
              </div>
            </div>
          </div>
          <div className="card">
            <div className="row-between">
              <div>
                <h3>{t('Живой фон')}</h3>
                <p className="hint" style={{ margin: 0 }}>
                  {t('Кольцо и мягкие свечения за панелями')}
                </p>
              </div>
              <Toggle on={app.liveBg} onChange={app.setLiveBg} />
            </div>
            <div className={'sub-settings' + (app.liveBg ? '' : ' off')}>
              <div className="row-between">
                <div>
                  <h4>{t('Свечения по краям')}</h4>
                  <p className="hint" style={{ margin: 0 }}>
                    {t('Цветные пятна света в углах экрана')}
                  </p>
                </div>
                <Toggle on={app.bgGlows} onChange={app.setBgGlows} disabled={!app.liveBg} />
              </div>
            </div>
          </div>
          <div className="card">
            <div className="row-between">
              <div>
                <h3>{t('Узор в чате')}</h3>
                <p className="hint" style={{ margin: 0 }}>
                  {t('Фоновый рисунок за сообщениями')}
                </p>
              </div>
              <Toggle on={app.chatPattern} onChange={app.setChatPattern} />
            </div>
          </div>
        </>
      );
    case 'privacy':
      return <Soon title={t('Конфиденциальность')} />;
    case 'notifications':
      return <Soon title={t('Уведомления')} />;
    case 'blocked':
      return <Soon title={t('Заблокированные')} text={t('Здесь пока никого нет.')} />;
  }
}
