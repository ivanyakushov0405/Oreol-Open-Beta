import { flushSync } from 'react-dom';
import { systemTheme, type AppState, type ThemePref } from '../../app/useAppState';
import { AccountEdit, AccountView } from './AccountSettings';
import { Toggle } from './Toggle';
import { CameraSettings, SoundSettings, VoiceDevices } from './VoiceSettings';
import type { UserSection } from './nav';

const THEME_LABEL: Record<ThemePref, string> = { system: 'Как в системе', dark: 'Тёмная', light: 'Светлая' };
const THEME_PREVIEW: Record<ThemePref, string> = {
  dark: 'linear-gradient(135deg,#040a14,#0e2238 60%,#2f7bff)',
  light: 'linear-gradient(135deg,#ffffff,#eef4fb 60%,#9fc2ff)',
  // половина тёмной, половина светлой
  system: 'linear-gradient(135deg,#040a14,#0e2238 49.5%,#eef4fb 50.5%,#9fc2ff)',
};

/** Смена темы: новая тема «выходит» из выбранной плашки — светлая разливается светом, тёмная — тьмой. */
function switchTheme(app: AppState, pref: ThemePref, from: HTMLElement) {
  if (app.themePref === pref) return;
  const t = pref === 'system' ? systemTheme() : pref;
  // тема на экране не меняется (например, «Как в системе» при тёмной системе и выбранной тёмной) — без анимации
  if (app.theme === t) {
    app.setTheme(pref);
    return;
  }
  const doc = document as Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void> } };
  // Firefox рисует снимки «разлива» без насыщенности стекла (backdrop-filter): во время анимации всё тусклее,
  // а в конце фон и панели «вспыхивают». Там тема меняется плавными переходами цветов, без снимков.
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
  // Страховка: если браузер не дал кадр для перехода (вкладка в фоне), тема меняется сразу
  window.setTimeout(() => {
    if (applied) return;
    vt.skipTransition?.();
    apply();
    delete root.dataset.vt;
  }, 1200);
  // Мягкий край: маска с радиальным градиентом, радиус анимируется (--vt-r зарегистрирован в CSS)
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
        {text ?? 'Скоро будет'}
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
              <h3>Микрофон</h3>
              <p className="hint" style={{ margin: 0 }}>
                {v.state === 'connected' ? 'Вы в «Лобби»' : v.micOn ? 'Включится при входе в голосовой канал' : 'Останется выключенным при входе в канал'}
              </p>
            </div>
            <Toggle on={v.micOn} onChange={() => v.toggleMic()} />
          </div>
          <div className="row-between">
            <div>
              <h3>Звук</h3>
              <p className="hint" style={{ margin: 0 }}>
                Выключите, чтобы не слышать собеседников
              </p>
            </div>
            <Toggle on={!v.deafened} onChange={() => v.toggleDeafen()} />
          </div>
        </div>
        <CameraSettings />
        <SoundSettings />
        </>
      );
    case 'appearance':
      return (
        <>
          <div className="card">
            <h3>Тема</h3>
            <p className="hint">Сохраняется на этом устройстве</p>
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
                <h3>Прозрачность интерфейса</h3>
                <p className="hint" style={{ margin: 0 }}>
                  Стеклянные панели, сквозь которые виден фон
                </p>
              </div>
              <Toggle on={app.glassUi} onChange={app.setGlassUi} />
            </div>
            <div className={'sub-settings' + (app.glassUi ? '' : ' off')}>
              <div className="row-between">
                <div>
                  <h4>Прозрачный чат</h4>
                  <p className="hint" style={{ margin: 0 }}>
                    Фон текстового чата становится стеклянным
                  </p>
                </div>
                <Toggle on={app.glassChat} onChange={app.setGlassChat} disabled={!app.glassUi} />
              </div>
              <div className="row-between">
                <div>
                  <h4>Прозрачный войс</h4>
                  <p className="hint" style={{ margin: 0 }}>
                    Фон голосового канала становится стеклянным
                  </p>
                </div>
                <Toggle on={app.glassVoice} onChange={app.setGlassVoice} disabled={!app.glassUi} />
              </div>
            </div>
          </div>
          <div className="card">
            <div className="row-between">
              <div>
                <h3>Живой фон</h3>
                <p className="hint" style={{ margin: 0 }}>
                  Кольцо и мягкие свечения за панелями
                </p>
              </div>
              <Toggle on={app.liveBg} onChange={app.setLiveBg} />
            </div>
            <div className={'sub-settings' + (app.liveBg ? '' : ' off')}>
              <div className="row-between">
                <div>
                  <h4>Свечения по краям</h4>
                  <p className="hint" style={{ margin: 0 }}>
                    Цветные пятна света в углах экрана
                  </p>
                </div>
                <Toggle on={app.bgGlows} onChange={app.setBgGlows} disabled={!app.liveBg} />
              </div>
            </div>
          </div>
          <div className="card">
            <div className="row-between">
              <div>
                <h3>Узор в чате</h3>
                <p className="hint" style={{ margin: 0 }}>
                  Фоновый рисунок за сообщениями
                </p>
              </div>
              <Toggle on={app.chatPattern} onChange={app.setChatPattern} />
            </div>
          </div>
        </>
      );
    case 'privacy':
      return <Soon title="Конфиденциальность" />;
    case 'notifications':
      return <Soon title="Уведомления" />;
    case 'blocked':
      return <Soon title="Заблокированные" text="Здесь пока никого нет." />;
  }
}
