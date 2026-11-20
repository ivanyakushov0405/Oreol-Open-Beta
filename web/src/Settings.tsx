import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { SENS_MAX, SENS_MIN, canPickOutput, readLevel, setAudioPrefs, useAudioPrefs } from './audioPrefs';
import { playSound } from './sounds';
import type { AppState } from './App';
import { Icon, type IconName } from './icons';
import { handleOf } from './mock';
import { Avatar, Banner } from './ui';
import { flushSync } from 'react-dom';

/** Смена темы: новая тема «выходит» из выбранной плашки — светлая разливается светом, тёмная — тьмой. */
function switchTheme(app: AppState, t: 'dark' | 'light', from: HTMLElement) {
  if (app.theme === t) return;
  const doc = document as Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void> } };
  if (!doc.startViewTransition) {
    app.setTheme(t);
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
    flushSync(() => app.setTheme(t));
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
import { ApiError, api, type Me } from './auth';

export type UserSection = 'account' | 'account-edit' | 'profile' | 'privacy' | 'notifications' | 'voice' | 'appearance' | 'blocked';
export type ServerSection = 'overview' | 'channels' | 'roles' | 'members' | 'invites' | 'audit' | 'moderation';

/** Разделы из адреса (/settings/:section, /servers/:sid/settings/:section) — только известные. */
export const isUserSection = (s: string | undefined): s is UserSection =>
  !!s && ['account', 'account-edit', 'profile', 'privacy', 'notifications', 'voice', 'appearance', 'blocked'].includes(s);
export const isServerSection = (s: string | undefined): s is ServerSection =>
  !!s && ['overview', 'channels', 'roles', 'members', 'invites', 'audit', 'moderation'].includes(s);

export const USER_NAV: { id: UserSection; label: string; icon: IconName; group?: string }[] = [
  { id: 'account', label: 'Учётная запись', icon: 'users' },
  { id: 'profile', label: 'Профиль', icon: 'pencil' },
  { id: 'privacy', label: 'Конфиденциальность', icon: 'shield' },
  { id: 'notifications', label: 'Уведомления', icon: 'bell' },
  { id: 'voice', label: 'Голос и звук', icon: 'mic', group: 'Приложение' },
  { id: 'appearance', label: 'Внешний вид', icon: 'appearance' },
  { id: 'blocked', label: 'Заблокированные', icon: 'block' },
];

/** Заголовок раздела. «Редактирование профиля» — подстраница «Учётной записи» (Figma). */
export function userSectionTitle(s: UserSection) {
  return s === 'account-edit' ? 'Редактирование профиля' : USER_NAV.find((n) => n.id === s)!.label;
}

/** Какой пункт навигации подсветить для раздела. */
export function userNavOf(s: UserSection): UserSection {
  return s === 'account-edit' ? 'account' : s;
}

export const SERVER_NAV: { id: ServerSection; label: string; icon: IconName; group?: string }[] = [
  { id: 'overview', label: 'Обзор', icon: 'settings' },
  { id: 'channels', label: 'Каналы', icon: 'chats' },
  { id: 'roles', label: 'Роли', icon: 'pin' },
  { id: 'members', label: 'Участники', icon: 'users' },
  { id: 'invites', label: 'Приглашения', icon: 'plus' },
  { id: 'audit', label: 'Журнал аудита', icon: 'search', group: 'Модерация' },
  { id: 'moderation', label: 'Модерация', icon: 'bell' },
];

function Toggle({ on, onChange, disabled }: { on: boolean; onChange?: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      className={'toggle' + (on ? ' on' : '')}
      style={disabled ? { opacity: 0.5 } : undefined}
      onClick={() => onChange?.(!on)}
    />
  );
}

/* ---------- Голос и звук: устройства, проверка микрофона, чувствительность, звуки ---------- */
const MIC_CAPTURE = { autoGainControl: true, noiseSuppression: true, echoCancellation: true, channelCount: 1 };

function useDevices() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const refresh = () => {
    navigator.mediaDevices
      ?.enumerateDevices()
      .then(setDevices)
      .catch(() => undefined);
  };
  useEffect(() => {
    refresh();
    navigator.mediaDevices?.addEventListener('devicechange', refresh);
    return () => navigator.mediaDevices?.removeEventListener('devicechange', refresh);
  }, []);
  return { devices, refresh };
}

function DeviceSelect({
  kind,
  value,
  onChange,
  devices,
}: {
  kind: MediaDeviceKind;
  value: string;
  onChange: (id: string) => void;
  devices: MediaDeviceInfo[];
}) {
  const list = devices.filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
  const word = kind === 'audioinput' ? 'Микрофон' : kind === 'videoinput' ? 'Камера' : 'Динамики';
  return (
    <div className="select">
      <select className="input" value={list.some((d) => d.deviceId === value) ? value : ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">По умолчанию (системное)</option>
        {list.map((d, i) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || `${word} ${i + 1}`}
          </option>
        ))}
      </select>
      <Icon name="chevron-down" size={18} />
    </div>
  );
}

const METER_MIN = -80;

/** Ползунок с подписью и значением. */
function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  format,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  return (
    <div className="slider">
      <div className="slider-head">
        <span className="field-label">{label}</span>
        <b>{format(value)}</b>
      </div>
      <input
        type="range"
        className="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
      />
    </div>
  );
}

/** Индикатор громкости. С порогом: выше — зелёный (голос пройдёт), ниже — серый. */
function LevelMeter({ level, threshold, active }: { level: number; threshold: number | null; active: boolean }) {
  const toPct = (db: number) => Math.max(0, Math.min(100, ((db - METER_MIN) / -METER_MIN) * 100));
  const pct = toPct(level);
  const th = threshold === null ? null : toPct(threshold);
  const pass = th === null || pct >= th;
  return (
    <div className={'level-meter' + (active ? '' : ' idle')}>
      <div className={'lm-fill' + (pass ? ' pass' : '')} style={{ width: `${pct}%` }} />
      {th !== null && <div className="lm-threshold" style={{ left: `${th}%` }} />}
    </div>
  );
}

function VoiceDevices() {
  const prefs = useAudioPrefs();
  const { devices, refresh } = useDevices();
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(-100);
  const [err, setErr] = useState<string | null>(null);
  const needLabels = devices.length > 0 && devices.every((d) => !d.label);
  const audioRef = useRef<HTMLAudioElement>(null);
  const gainRef = useRef<GainNode | null>(null);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const getPrefs = () => prefsRef.current;

  // Проверка: захватываем выбранный микрофон, показываем уровень и возвращаем звук в выбранные наушники.
  useEffect(() => {
    if (!testing) {
      setLevel(-100);
      return;
    }
    let alive = true;
    let stream: MediaStream | null = null;
    let ac: AudioContext | null = null;
    let raf = 0;
    const el = audioRef.current;
    (async () => {
      try {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: prefs.inputId ? { ...MIC_CAPTURE, deviceId: { exact: prefs.inputId } } : MIC_CAPTURE,
          });
        } catch (e) {
          // Сохранённый микрофон отключён/сменил id (OverconstrainedError/NotFoundError) — берём микрофон по умолчанию
          const name = (e as DOMException)?.name;
          if (!prefs.inputId || (name !== 'OverconstrainedError' && name !== 'NotFoundError' && name !== 'NotReadableError')) throw e;
          stream = await navigator.mediaDevices.getUserMedia({ audio: MIC_CAPTURE });
          setAudioPrefs({ inputId: '' });
        }
        if (!alive) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        refresh(); // после разрешения браузер отдаёт названия устройств
        setErr(null);
        ac = new AudioContext();
        // Контекст, созданный после await, браузер может оставить «на паузе» — тогда индикатор стоит на нуле
        if (ac.state === 'suspended') await ac.resume().catch(() => undefined);
        const an = ac.createAnalyser();
        an.fftSize = 1024;
        const gain = ac.createGain();
        const dest = ac.createMediaStreamDestination();
        gainRef.current = gain;
        gain.gain.value = getPrefs().inputVolume;
        ac.createMediaStreamSource(stream).connect(gain);
        gain.connect(an);
        gain.connect(dest);
        const buf = new Float32Array(1024);
        let smooth = -100;
        const loop = () => {
          const db = readLevel(an, buf);
          smooth = db > smooth ? db : smooth * 0.85 + db * 0.15; // быстро вверх, плавно вниз
          setLevel(smooth);
          raf = requestAnimationFrame(loop);
        };
        loop();
        if (el) {
          el.srcObject = dest.stream;
          el.volume = getPrefs().outputVolume;
          const sinkable = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
          if (prefs.outputId && sinkable.setSinkId) await sinkable.setSinkId(prefs.outputId).catch(() => undefined);
          await el.play().catch(() => undefined);
        }
      } catch (e) {
        if (alive) {
          const name = (e as DOMException)?.name;
          setErr(
            name === 'NotAllowedError' || name === 'SecurityError'
              ? 'Нет доступа к микрофону — разрешите его в настройках браузера'
              : name === 'NotFoundError'
                ? 'Микрофон не найден — подключите устройство ввода'
                : name === 'NotReadableError'
                  ? 'Микрофон занят другим приложением'
                  : 'Не удалось запустить проверку микрофона',
          );
          setTesting(false);
        }
      }
    })();
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      void ac?.close();
      if (el) el.srcObject = null;
    };
  }, [testing, prefs.inputId, prefs.outputId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Громкости меняются на лету, без перезапуска проверки
  useEffect(() => {
    if (gainRef.current) gainRef.current.gain.value = prefs.inputVolume;
    if (audioRef.current) audioRef.current.volume = prefs.outputVolume;
  }, [prefs.inputVolume, prefs.outputVolume]);

  const askLabels = async () => {
    try {
      const st = await navigator.mediaDevices.getUserMedia({ audio: true });
      st.getTracks().forEach((t) => t.stop());
      refresh();
    } catch {
      setErr('Нет доступа к микрофону — разрешите его в настройках браузера');
    }
  };

  return (
    <>
      <div className="card">
        <h3>Устройства</h3>
        <div className="device-grid">
          <label>
            <span className="field-label">Устройство ввода</span>
            <DeviceSelect kind="audioinput" devices={devices} value={prefs.inputId} onChange={(id) => setAudioPrefs({ inputId: id })} />
            <Slider
              label="Громкость ввода"
              value={Math.round(prefs.inputVolume * 100)}
              min={0}
              max={200}
              format={(v) => `${v}%`}
              onChange={(v) => setAudioPrefs({ inputVolume: v / 100 })}
            />
          </label>
          <label>
            <span className="field-label">Устройство вывода</span>
            {canPickOutput ? (
              <DeviceSelect kind="audiooutput" devices={devices} value={prefs.outputId} onChange={(id) => setAudioPrefs({ outputId: id })} />
            ) : (
              <p className="hint" style={{ margin: '10px 0 0' }}>
                Этот браузер не умеет выбирать динамики — звук идёт в системное устройство
              </p>
            )}
            <Slider
              label="Громкость вывода"
              value={Math.round(prefs.outputVolume * 100)}
              min={0}
              max={100}
              format={(v) => `${v}%`}
              onChange={(v) => setAudioPrefs({ outputVolume: v / 100 })}
            />
          </label>
        </div>
        {needLabels && (
          <p className="hint" style={{ margin: '12px 0 0' }}>
            Браузер скрывает названия устройств.{' '}
            <button type="button" className="link-btn" onClick={askLabels}>
              Разрешить доступ к микрофону
            </button>
          </p>
        )}
      </div>

      <div className="card">
        <div className="row-between">
          <div>
            <h3>Проверка микрофона</h3>
            <p className="hint" style={{ margin: 0 }}>
              {testing ? 'Говорите — вы слышите себя так, как вас слышат другие' : 'Скажите что-нибудь и послушайте себя в наушниках'}
            </p>
          </div>
          <button type="button" className={'btn ' + (testing ? 'btn-secondary' : 'btn-primary')} onClick={() => setTesting((t) => !t)}>
            <Icon name={testing ? 'mic-off' : 'mic'} size={18} />
            {testing ? 'Остановить' : 'Проверить'}
          </button>
        </div>
        <LevelMeter level={level} threshold={null} active={testing} />
        {err && <p className="hint danger-text" style={{ margin: '10px 0 0' }}>{err}</p>}
        <audio ref={audioRef} hidden />
      </div>

      <div className="card">
        <div className="row-between">
          <div>
            <h3>Чувствительность ввода</h3>
            <p className="hint" style={{ margin: 0 }}>
              {prefs.autoSensitivity
                ? 'Определяется автоматически — фоновый шум подавляет браузер'
                : 'Звук тише порога не передаётся. Зелёная полоса — голос проходит'}
            </p>
          </div>
          <div className="inline-toggle">
            <span>Автоматически</span>
            <Toggle on={prefs.autoSensitivity} onChange={(v) => setAudioPrefs({ autoSensitivity: v })} />
          </div>
        </div>
        <div className={'sens' + (prefs.autoSensitivity ? ' off' : '')}>
          <LevelMeter level={level} threshold={prefs.sensitivity} active={testing} />
          <input
            type="range"
            className="range"
            min={SENS_MIN}
            max={SENS_MAX}
            step={1}
            value={prefs.sensitivity}
            disabled={prefs.autoSensitivity}
            onChange={(e) => setAudioPrefs({ sensitivity: Number(e.target.value) })}
            aria-label="Порог чувствительности"
          />
          <div className="sens-scale">
            <span>Ловит тихий голос</span>
            <b>{prefs.sensitivity} дБ</b>
            <span>Только громкий голос</span>
          </div>
          {!testing && !prefs.autoSensitivity && (
            <p className="hint" style={{ margin: '6px 0 0' }}>
              Нажмите «Проверить» выше, чтобы видеть свой голос относительно порога
            </p>
          )}
        </div>
      </div>
    </>
  );
}


function CameraSettings() {
  const prefs = useAudioPrefs();
  const { devices, refresh } = useDevices();
  const [preview, setPreview] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const cams = devices.filter((d) => d.kind === 'videoinput');

  useEffect(() => {
    if (!preview) return;
    let alive = true;
    let stream: MediaStream | null = null;
    const el = videoRef.current;
    navigator.mediaDevices
      .getUserMedia({ video: prefs.videoId ? { deviceId: { exact: prefs.videoId } } : true })
      .then((st) => {
        stream = st;
        if (!alive) return st.getTracks().forEach((t) => t.stop());
        setErr(null);
        refresh();
        if (el) {
          el.srcObject = st;
          void el.play().catch(() => undefined);
        }
      })
      .catch(() => {
        if (alive) {
          setErr('Нет доступа к камере — разрешите её в настройках браузера');
          setPreview(false);
        }
      });
    return () => {
      alive = false;
      stream?.getTracks().forEach((t) => t.stop());
      if (el) el.srcObject = null;
    };
  }, [preview, prefs.videoId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="card">
      <div className="row-between">
        <div>
          <h3>Камера</h3>
          <p className="hint" style={{ margin: 0 }}>
            {cams.length === 0 ? 'Нажмите «Предпросмотр», чтобы браузер нашёл камеру' : 'Включается кнопкой камеры в голосовом канале'}
          </p>
        </div>
        <button type="button" className={'btn ' + (preview ? 'btn-secondary' : 'btn-primary')} onClick={() => setPreview((v) => !v)}>
          <Icon name={preview ? 'video-off' : 'video'} size={18} />
          {preview ? 'Остановить' : 'Предпросмотр'}
        </button>
      </div>
      <div className="device-grid one">
        <label>
          <span className="field-label">Устройство</span>
          <DeviceSelect kind="videoinput" devices={devices} value={prefs.videoId} onChange={(id) => setAudioPrefs({ videoId: id })} />
        </label>
      </div>
      <div className={'cam-preview' + (preview ? ' on' : '')}>
        <video ref={videoRef} muted playsInline className="mirror" />
        {!preview && (
          <span>
            <Icon name="video-off" size={28} />
            Предпросмотр выключен
          </span>
        )}
      </div>
      {err && <p className="hint danger-text" style={{ margin: '10px 0 0' }}>{err}</p>}
    </div>
  );
}

const SOUND_LIST = [
  ['join', 'Вход'],
  ['leave', 'Выход'],
  ['mic-on', 'Микрофон вкл.'],
  ['mic-off', 'Микрофон выкл.'],
  ['undeafen', 'Звук вкл.'],
  ['deafen', 'Звук выкл.'],
  ['share-on', 'Демонстрация'],
  ['share-off', 'Конец демонстрации'],
] as const;

function SoundSettings() {
  const prefs = useAudioPrefs();
  return (
    <div className="card">
      <div className="row-between">
        <div>
          <h3>Звуки</h3>
          <p className="hint" style={{ margin: 0 }}>
            Вход и выход из голосового, микрофон, наушники, демонстрация
          </p>
        </div>
        <Toggle on={prefs.sounds} onChange={(v) => setAudioPrefs({ sounds: v })} />
      </div>
      <div className={'sub-settings' + (prefs.sounds ? '' : ' off')}>
        <div className="sound-volume">
          <h4>Громкость звуков</h4>
          <input
            type="range"
            className="range"
            min={0}
            max={100}
            value={Math.round(prefs.soundVolume * 100)}
            disabled={!prefs.sounds}
            onChange={(e) => setAudioPrefs({ soundVolume: Number(e.target.value) / 100 })}
            onPointerUp={() => playSound('join')}
            aria-label="Громкость звуков"
          />
        </div>
        <div className="sound-chips">
          {SOUND_LIST.map(([id, label]) => (
            <button key={id} type="button" className="btn btn-secondary btn-sm" disabled={!prefs.sounds} onClick={() => playSound(id)}>
              <Icon name="voice" size={16} />
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}


/* ---------- Учётная запись (Figma «Desktop · User settings») ---------- */
function maskEmail(email: string) {
  const [user, domain] = email.split('@');
  return `${user?.[0] ?? ''}•••••@${domain ?? ''}`;
}

/** +79991234567 → +7 (999) 123-45-67; другие страны — +цифры. */
function formatPhone(phone: string | null | undefined) {
  if (!phone) return '';
  return phoneInput(phone);
}

/** Маска при вводе: российские номера (+7 / 8) форматируются, остальные — +цифры. */
function phoneInput(raw: string) {
  let d = raw.replace(/\D/g, '').slice(0, 15);
  if (!d) return '';
  if (d[0] === '8') d = '7' + d.slice(1);
  if (d[0] !== '7') return '+' + d;
  const p = d.slice(1, 11);
  let out = '+7';
  if (p.length) out += ' (' + p.slice(0, 3);
  if (p.length > 3) out += ') ' + p.slice(3, 6);
  if (p.length > 6) out += '-' + p.slice(6, 8);
  if (p.length > 8) out += '-' + p.slice(8, 10);
  return out;
}

function errText(e: unknown, fallback: string) {
  return e instanceof Error && e.message ? e.message : fallback;
}

/** Диалог поверх настроек. Esc закрывает только его, а не весь экран настроек. */
function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return createPortal(
    <div
      className="dialog-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>,
    document.body,
  );
}

function PasswordDialog({ app, onClose }: { app: AppState; onClose: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (next.length < 8) return setErrs({ password: 'Минимум 8 символов' });
    if (next !== repeat) return setErrs({ repeat: 'Пароли не совпадают' });
    setBusy(true);
    setErrs({});
    try {
      await api('/api/account/password', { method: 'POST', body: { current, password: next } });
      app.notify('Пароль изменён. Другие сессии завершены', 'success');
      onClose();
    } catch (err) {
      setErrs(err instanceof ApiError && Object.keys(err.fields).length ? err.fields : { _: errText(err, 'Не удалось сменить пароль') });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Сменить пароль" onClose={onClose}>
      <form className="dialog-form" onSubmit={submit}>
        <AccField label="Текущий пароль" error={errs.current}>
          <input className="input" type="password" autoComplete="current-password" autoFocus value={current} onChange={(e) => setCurrent(e.target.value)} />
        </AccField>
        <AccField label="Новый пароль" error={errs.password}>
          <input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        </AccField>
        <AccField label="Повторите новый пароль" error={errs.repeat}>
          <input className="input" type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
        </AccField>
        {errs._ && <p className="field-hint error">{errs._}</p>}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !current || !next}>
            {busy ? 'Сохраняем…' : 'Сменить пароль'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function DeleteDialog({ app, onClose }: { app: AppState; onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api('/api/account', { method: 'DELETE', body: { password } });
      app.logout();
    } catch (er) {
      setErr(errText(er, 'Не удалось удалить аккаунт'));
      setBusy(false);
    }
  };
  return (
    <Dialog title="Удалить аккаунт?" onClose={onClose}>
      <form className="dialog-form" onSubmit={submit}>
        <p className="hint" style={{ margin: 0 }}>
          Аккаунт, ваши сообщения, аватар и фон будут удалены без возможности восстановления. Для подтверждения введите пароль.
        </p>
        <AccField label="Пароль" error={err ?? undefined}>
          <input className="input" type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        </AccField>
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" className="btn btn-danger-solid" disabled={busy || !password}>
            <Icon name="trash" size={16} />
            {busy ? 'Удаляем…' : 'Удалить навсегда'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function AccField({ label, error, children }: { label: string; error?: string; children: ReactNode }) {
  return (
    <label className="acc-input">
      <span className="field-label">{label}</span>
      {children}
      {error && <span className="field-hint error">{error}</span>}
    </label>
  );
}

/** Шапка: баннер, аватар со статусом, имя, @ник и кнопка действия. */
function AccountHead({ app, children, onAvatar, onBanner }: { app: AppState; children: ReactNode; onAvatar?: () => void; onBanner?: () => void }) {
  return (
    <div className="card profile-card account-head">
      {onBanner ? (
        <button type="button" className="banner-edit" title="Сменить баннер" onClick={onBanner}>
          <Banner name={app.name} />
        </button>
      ) : (
        <Banner name={app.name} />
      )}
      {onAvatar ? (
        <button type="button" className="avatar-edit" title="Сменить аватар" onClick={onAvatar}>
          <Avatar name={app.name} size={80} status={app.status} />
        </button>
      ) : (
        <Avatar name={app.name} size={80} status={app.status} />
      )}
      <h2>{app.me.displayName}</h2>
      <div className="handle">{handleOf(app.name)}</div>
      {children}
    </div>
  );
}

function AccountView({ app, onEdit }: { app: AppState; onEdit: () => void }) {
  const [showEmail, setShowEmail] = useState(false);
  const [pw, setPw] = useState(false);
  const me = app.me;
  return (
    <>
      <AccountHead app={app}>
        <button type="button" className="btn btn-secondary btn-xs" onClick={onEdit}>
          <Icon name="pencil" size={16} />
          Редактировать профиль
        </button>
      </AccountHead>
      <div className="card account-data">
        <h3>Данные аккаунта</h3>
        <div className="acc-field">
          <div className="overline">Отображаемое имя</div>
          <div className="v">{me.displayName}</div>
        </div>
        <div className="acc-field">
          <div className="overline">Имя пользователя</div>
          <div className="v">{handleOf(me.username)}</div>
        </div>
        <div className="acc-row">
          <div className="acc-field">
            <div className="overline">Email</div>
            <div className="v">{showEmail ? me.email : maskEmail(me.email)}</div>
          </div>
          <button type="button" className="btn btn-secondary btn-xs" onClick={() => setShowEmail((x) => !x)}>
            {showEmail ? 'Скрыть' : 'Показать'}
          </button>
        </div>
        <div className="acc-field">
          <div className="overline">Телефон</div>
          <div className="v">{formatPhone(me.phone) || 'Не добавлен'}</div>
        </div>
      </div>
      <div className="card account-security">
        <h3>Пароль и безопасность</h3>
        <div className="acc-actions">
          <button type="button" className="btn btn-primary" onClick={() => setPw(true)}>
            Сменить пароль
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => app.notify('Двухфакторная аутентификация появится позже')}>
            Включить 2FA
          </button>
        </div>
      </div>
      {pw && <PasswordDialog app={app} onClose={() => setPw(false)} />}
    </>
  );
}

/* ---------- Редактирование профиля (Figma «Desktop · User settings · Редактирование профиля») ---------- */
function AccountEdit({ app, onDone }: { app: AppState; onDone: () => void }) {
  const me = app.me;
  const initial = { displayName: me.displayName, username: me.username, email: me.email, phone: formatPhone(me.phone) };
  const [form, setForm] = useState(initial);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<'avatar' | 'banner' | null>(null);
  const [menu, setMenu] = useState(false);
  const [del, setDel] = useState(false);
  const avatarInput = useRef<HTMLInputElement>(null);
  const bannerInput = useRef<HTMLInputElement>(null);
  const set = (k: keyof typeof initial) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: k === 'phone' ? phoneInput(e.target.value) : e.target.value }));
  const dirty = (Object.keys(initial) as (keyof typeof initial)[]).some((k) => form[k].trim() !== initial[k]);

  const save = async () => {
    setSaving(true);
    setErrs({});
    try {
      const r = await api<{ user: Me }>('/api/account', {
        method: 'PATCH',
        body: { displayName: form.displayName, username: form.username, email: form.email, phone: form.phone },
      });
      app.updateMe(r.user);
      app.notify('Профиль сохранён', 'success');
      onDone();
    } catch (e) {
      setErrs(e instanceof ApiError && Object.keys(e.fields).length ? e.fields : { _: errText(e, 'Не удалось сохранить') });
    } finally {
      setSaving(false);
    }
  };

  const image = async (kind: 'avatar' | 'banner', file?: File) => {
    setMenu(false);
    setBusy(kind);
    try {
      const r = await api<{ user: Me }>(`/api/profile/${kind}`, file ? { method: 'PUT', body: file } : { method: 'DELETE' });
      app.updateMe(r.user);
    } catch (e) {
      app.notify(errText(e, 'Не удалось обновить изображение'), 'error');
    } finally {
      setBusy(null);
    }
  };
  const picker = (kind: 'avatar' | 'banner', ref: React.RefObject<HTMLInputElement>) => (
    <input
      ref={ref}
      type="file"
      accept="image/png,image/jpeg,image/webp,image/gif"
      hidden
      onChange={(e) => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (f) void image(kind, f);
      }}
    />
  );

  return (
    <>
      <AccountHead app={app} onAvatar={() => avatarInput.current?.click()} onBanner={() => bannerInput.current?.click()}>
        <div className="img-menu-wrap">
          <button type="button" className="btn btn-secondary btn-xs" disabled={busy !== null} onClick={() => setMenu((m) => !m)} aria-expanded={menu}>
            <Icon name="pencil" size={16} />
            {busy ? 'Загрузка…' : 'Сменить аватар и баннер'}
          </button>
          {menu && (
            <>
              <div className="popover-backdrop" onClick={() => setMenu(false)} />
              <div className="img-menu" role="menu">
                <button role="menuitem" onClick={() => avatarInput.current?.click()}>
                  Загрузить аватар
                </button>
                <button role="menuitem" onClick={() => bannerInput.current?.click()}>
                  Загрузить баннер
                </button>
                {me.avatar && (
                  <button role="menuitem" className="danger" onClick={() => void image('avatar')}>
                    Убрать аватар
                  </button>
                )}
                {me.banner && (
                  <button role="menuitem" className="danger" onClick={() => void image('banner')}>
                    Убрать баннер
                  </button>
                )}
                <span className="img-menu-hint">PNG, JPG, WEBP или GIF · аватар до 3 МБ, баннер до 6 МБ</span>
              </div>
            </>
          )}
        </div>
        {picker('avatar', avatarInput)}
        {picker('banner', bannerInput)}
      </AccountHead>

      <form
        className="card acc-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty && !saving) void save();
        }}
      >
        <h3>Профиль</h3>
        <div className="acc-grid">
          <AccField label="Отображаемое имя" error={errs.displayName}>
            <input className="input" value={form.displayName} maxLength={32} onChange={set('displayName')} />
          </AccField>
          <AccField label="Имя пользователя" error={errs.username}>
            <input className="input" value={form.username} maxLength={32} autoComplete="username" onChange={set('username')} />
          </AccField>
          <AccField label="Email" error={errs.email}>
            <input className="input" type="email" value={form.email} autoComplete="email" onChange={set('email')} />
          </AccField>
          <AccField label="Телефон" error={errs.phone}>
            <input className="input" type="tel" value={form.phone} placeholder="+7 (___) ___-__-__" autoComplete="tel" onChange={set('phone')} />
          </AccField>
        </div>
        {errs._ && <p className="field-hint error">{errs._}</p>}
        <button type="submit" hidden />
      </form>
      <div className="acc-actions-end">
        <button type="button" className="btn btn-secondary" onClick={onDone}>
          Отмена
        </button>
        <button type="button" className="btn btn-primary" disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? 'Сохраняем…' : 'Сохранить'}
        </button>
      </div>
      <div className="card danger-card">
        <div className="grow">
          <b>Удаление аккаунта</b>
          <p>Аккаунт и все данные будут удалены без возможности восстановления.</p>
        </div>
        <button type="button" className="btn btn-danger-solid btn-xs" onClick={() => setDel(true)}>
          <Icon name="trash" size={16} />
          Удалить аккаунт
        </button>
      </div>
      {del && <DeleteDialog app={app} onClose={() => setDel(false)} />}
    </>
  );
}

/* ---------- Профиль: отображаемое имя, «О себе», аватар и фон (файлы хранятся на сервере) ---------- */
const MAX_BIO = 190;

function ProfileEditor({ app }: { app: AppState }) {
  const me = app.me;
  const [display, setDisplay] = useState(me.displayName);
  const [bio, setBio] = useState(me.bio);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<'avatar' | 'banner' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const avatarInput = useRef<HTMLInputElement>(null);
  const bannerInput = useRef<HTMLInputElement>(null);
  const dirty = display.trim() !== me.displayName || bio.trim() !== me.bio;

  const save = async () => {
    if (!display.trim()) return setErr('Отображаемое имя не может быть пустым');
    setSaving(true);
    setErr(null);
    try {
      const r = await api<{ user: Me }>('/api/profile', { method: 'PATCH', body: { displayName: display.trim(), bio: bio.trim() } });
      app.updateMe(r.user);
      setDisplay(r.user.displayName);
      setBio(r.user.bio);
      app.notify('Профиль сохранён', 'success');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Не удалось сохранить');
    } finally {
      setSaving(false);
    }
  };

  const upload = async (kind: 'avatar' | 'banner', file: File | undefined) => {
    if (!file) return;
    setBusy(kind);
    setErr(null);
    try {
      const r = await api<{ user: Me }>(`/api/profile/${kind}`, { method: 'PUT', body: file });
      app.updateMe(r.user);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Не удалось загрузить файл');
    } finally {
      setBusy(null);
    }
  };

  const remove = async (kind: 'avatar' | 'banner') => {
    setBusy(kind);
    setErr(null);
    try {
      const r = await api<{ user: Me }>(`/api/profile/${kind}`, { method: 'DELETE' });
      app.updateMe(r.user);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Не удалось удалить');
    } finally {
      setBusy(null);
    }
  };

  const picker = (kind: 'avatar' | 'banner', ref: React.RefObject<HTMLInputElement>) => (
    <input
      ref={ref}
      type="file"
      accept="image/png,image/jpeg,image/webp,image/gif"
      hidden
      onChange={(e) => {
        void upload(kind, e.target.files?.[0]);
        e.target.value = '';
      }}
    />
  );

  return (
    <div className="grid-2">
      <div className="card kv profile-form">
        <label>
          <span className="field-label">Отображаемое имя</span>
          <input className="input" value={display} maxLength={32} onChange={(e) => setDisplay(e.target.value)} />
        </label>
        <label>
          <span className="field-label">О себе</span>
          <textarea
            className="input textarea"
            rows={3}
            value={bio}
            maxLength={MAX_BIO}
            placeholder="Пара слов о себе — её увидят в карточке участника"
            onChange={(e) => setBio(e.target.value)}
          />
          <span className="field-hint">
            {bio.length}/{MAX_BIO}
          </span>
        </label>
        <div className="upload-row">
          <div>
            <span className="field-label">Аватар</span>
            <p className="hint" style={{ margin: 0 }}>
              PNG, JPG, WEBP или GIF, до 3 МБ. Лучше квадратный.
            </p>
          </div>
          <div className="upload-actions">
            {me.avatar && (
              <button type="button" className="btn btn-secondary btn-sm" disabled={busy !== null} onClick={() => void remove('avatar')}>
                Убрать
              </button>
            )}
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy !== null} onClick={() => avatarInput.current?.click()}>
              {busy === 'avatar' ? 'Загрузка…' : 'Загрузить'}
            </button>
          </div>
          {picker('avatar', avatarInput)}
        </div>
        <div className="upload-row">
          <div>
            <span className="field-label">Фон профиля</span>
            <p className="hint" style={{ margin: 0 }}>
              До 6 МБ. Подойдёт широкая картинка, примерно 3:1.
            </p>
          </div>
          <div className="upload-actions">
            {me.banner && (
              <button type="button" className="btn btn-secondary btn-sm" disabled={busy !== null} onClick={() => void remove('banner')}>
                Убрать
              </button>
            )}
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy !== null} onClick={() => bannerInput.current?.click()}>
              {busy === 'banner' ? 'Загрузка…' : 'Загрузить'}
            </button>
          </div>
          {picker('banner', bannerInput)}
        </div>
        {err && <p className="hint danger-text" style={{ margin: 0 }}>{err}</p>}
        <div className="row-between" style={{ justifyContent: 'flex-end', gap: 8 }}>
          {dirty && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setDisplay(me.displayName);
                setBio(me.bio);
              }}
            >
              Отменить
            </button>
          )}
          <button type="button" className="btn btn-primary" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? 'Сохраняем…' : 'Сохранить'}
          </button>
        </div>
      </div>
      {/* Превью — как вас видят другие */}
      <div className="card profile-card profile-preview">
        <button type="button" className="banner-edit" title="Сменить фон" onClick={() => bannerInput.current?.click()}>
          <Banner name={app.name} />
        </button>
        <button type="button" className="avatar-edit" title="Сменить аватар" onClick={() => avatarInput.current?.click()}>
          <Avatar name={app.name} size={72} status={app.status} />
          <span className="avatar-edit-ico">
            <Icon name="pencil" size={14} />
          </span>
        </button>
        <h2>{display.trim() || me.displayName}</h2>
        <div className="handle">{handleOf(app.name)}</div>
        {bio.trim() && <p className="preview-bio">{bio.trim()}</p>}
        <div style={{ height: 20 }} />
      </div>
    </div>
  );
}

function Soon({ title, text }: { title: string; text?: string }) {
  return (
    <div className="card">
      <h3>{title}</h3>
      <p className="hint" style={{ margin: 0 }}>
        {text ?? 'Раздел появится вместе с полноценным бэкендом. Сейчас это демонстрация дизайна.'}
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
      return <AccountView app={app} onEdit={() => onSection?.('account-edit')} />;
    case 'account-edit':
      return <AccountEdit app={app} onDone={() => onSection?.('account')} />;
    case 'profile':
      return <ProfileEditor app={app} />;
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
              {(['dark', 'light'] as const).map((t) => (
                <button key={t} className={'theme-card' + (app.theme === t ? ' on' : '')} onClick={(e) => switchTheme(app, t, e.currentTarget)}>
                  <div
                    className="preview"
                    style={{
                      background:
                        t === 'dark'
                          ? 'linear-gradient(135deg,#040a14,#0e2238 60%,#2f7bff)'
                          : 'linear-gradient(135deg,#ffffff,#eef4fb 60%,#9fc2ff)',
                    }}
                  />
                  {t === 'dark' ? 'Тёмная' : 'Светлая'}
                </button>
              ))}
            </div>
          </div>
          <div className="card">
            <div className="row-between">
              <div>
                <h3>Прозрачность интерфейса</h3>
                <p className="hint" style={{ margin: 0 }}>
                  Стеклянные панели, сквозь которые виден фон. Выключите — всё станет непрозрачным
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

export function ServerSettingsBody({ app, section }: { app: AppState; section: ServerSection }) {
  switch (section) {
    case 'overview':
      return (
        <div className="grid-2">
          <div className="card kv">
            <label>
              <span className="field-label">Название сервера</span>
              <input className="input" value={app.server.name} disabled />
            </label>
            <label>
              <span className="field-label">Описание</span>
              <input className="input" value={app.server.about} disabled />
            </label>
            <p className="hint" style={{ margin: 0 }}>
              Редактирование появится с полноценным бэкендом
            </p>
          </div>
          <div className="card profile-card">
            <div className="banner" />
            <span
              className="avatar"
              style={{ width: 72, height: 72, margin: '-36px auto 0', background: app.server.gradient, fontSize: 24 }}
            >
              {app.server.short}
            </span>
            <h2>{app.server.name}</h2>
            <div className="handle">
              {app.membersOnline.length} в сети · {app.members.length} участников
            </div>
            <div style={{ height: 20 }} />
          </div>
        </div>
      );
    case 'roles':
      return <RolesEditor app={app} />;
    case 'members':
      return (
        <div className="card">
          <h3>Участники — {app.members.length}</h3>
          <p className="hint">Все, кто состоит на сервере; {app.membersOnline.length} сейчас в сети</p>
          {app.members.map((m) => (
            <div className="list-row" key={m.username}>
              <Avatar name={m.username} size={28} status={m.status} />
              <span className="grow" style={{ color: 'var(--text-primary)' }}>
                {m.displayName}
                {m.username === app.name ? ' (вы)' : ''}
              </span>
              <span>{handleOf(m.username)}</span>
            </div>
          ))}
        </div>
      );
    case 'channels':
      return <Soon title="Каналы" text="Создавать и редактировать каналы пока нельзя — нет полноценного бэкенда." />;
    case 'invites':
      return <Soon title="Приглашения" />;
    case 'audit':
      return <Soon title="Журнал аудита" />;
    case 'moderation':
      return <Soon title="Модерация" />;
  }
}

/** Полноэкранные настройки на десктопе. */
export function SettingsScreen<T extends string>({
  title,
  overline,
  nav,
  section,
  onSection,
  onClose,
  footer,
  children,
  active,
}: {
  title: string;
  overline: string;
  nav: { id: T; label: string; icon: IconName; group?: string }[];
  section: T;
  /** Подсвеченный пункт навигации, если раздел — подстраница. */
  active?: T;
  onSection: (s: T) => void;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="settings">
      <nav className="settings-nav glass">
        <div className="overline">{overline}</div>
        {nav.map((n) => (
          <Fragment key={n.id}>
            {n.group && <div className="overline">{n.group}</div>}
            <button className={'nav-item' + ((active ?? section) === n.id ? ' on' : '')} onClick={() => onSection(n.id)}>
              <Icon name={n.icon} size={20} />
              {n.label}
            </button>
          </Fragment>
        ))}
        {footer}
      </nav>
      <main className="settings-body glass">
        {/* Шапка из Figma: заголовок H1 + кнопка закрытия 32×32 r10 с подписью ESC */}
        <div className="settings-head">
          <h1>{title}</h1>
          <div className="settings-close">
            <button type="button" className="settings-x" onClick={onClose} title="Закрыть (Esc)" aria-label="Закрыть">
              <Icon name="close" size={20} />
            </button>
            <span>ESC</span>
          </div>
        </div>
        {children}
      </main>
    </div>
  );
}

/* ---------- Роли (макет «Desktop · Server settings · Роли») ---------- */
const ROLE_SWATCHES = ['#00e5ff', '#ff5c7a', '#7a5cff', '#3ddc97', '#ffb840', '#548fff', '#fa78d9', '#5c7590'];
const PERMISSIONS = [
  { id: 'channels', title: 'Управлять каналами', text: 'Создавать, менять и удалять каналы' },
  { id: 'messages', title: 'Удалять сообщения', text: 'Чужие сообщения в любом канале' },
  { id: 'kick', title: 'Выгонять участников', text: 'Можно вернуться по приглашению' },
  { id: 'ban', title: 'Банить участников', text: 'Блокировка без возможности войти' },
  { id: 'everyone', title: 'Упоминать @everyone', text: 'Уведомление всем участникам' },
] as const;
type PermId = (typeof PERMISSIONS)[number]['id'];
interface RoleState {
  id: string;
  name: string;
  color: string;
  perms: Record<PermId, boolean>;
}
const allPerms = (on: boolean): Record<PermId, boolean> => ({ channels: on, messages: on, kick: on, ban: on, everyone: on });
const INITIAL_ROLES: RoleState[] = [
  { id: 'admin', name: 'Админ', color: '#ff5c7a', perms: allPerms(true) },
  { id: 'mod', name: 'Модератор', color: '#00e5ff', perms: { channels: true, messages: true, kick: true, ban: false, everyone: false } },
  { id: 'raid', name: 'Рейд-лид', color: '#7a5cff', perms: { channels: false, messages: false, kick: false, ban: false, everyone: true } },
  { id: 'healer', name: 'Хилер', color: '#3ddc97', perms: allPerms(false) },
  { id: 'everyone', name: '@everyone', color: '#5c7590', perms: allPerms(false) },
];

function RoleRow({ role, count, on, onClick }: { role: RoleState; count: string; on: boolean; onClick: () => void }) {
  return (
    <button type="button" className={'role-row' + (on ? ' on' : '')} onClick={onClick}>
      <span className="role-color">
        <i style={{ background: role.color }} />
      </span>
      <span className="role-name" style={{ color: role.color }}>
        {role.name || 'Без названия'}
      </span>
      <span className="role-count">{count}</span>
      <Icon name="chevron-right" size={18} />
    </button>
  );
}

function RolesEditor({ app }: { app: AppState }) {
  const [roles, setRoles] = useState(INITIAL_ROLES);
  const [selected, setSelected] = useState('mod');
  const role = roles.find((r) => r.id === selected)!;
  const update = (patch: Partial<RoleState>) => setRoles((rs) => rs.map((r) => (r.id === selected ? { ...r, ...patch } : r)));
  const custom = roles.filter((r) => r.id !== 'everyone');
  const everyone = roles.find((r) => r.id === 'everyone')!;
  const locked = role.id === 'everyone';
  // Мок-участников нет: «Админ» — владелец сервера (вы), @everyone — все, кто сейчас в сети.
  const countOf = (r: RoleState) => (r.id === 'everyone' ? `все ${app.members.length}` : `${r.id === 'admin' ? 1 : 0} уч.`);

  return (
    <div className="roles-layout">
      <section className="roles-panel">
        <div className="roles-head">
          <h3>Роли — {custom.length}</h3>
          <p>Выше по списку — главнее. Перетаскивайте, чтобы изменить порядок.</p>
        </div>
        <div className="roles-list">
          {custom.map((r, i) => (
            <Fragment key={r.id}>
              {i > 0 && <div className="roles-divider" />}
              <RoleRow role={r} count={countOf(r)} on={r.id === selected} onClick={() => setSelected(r.id)} />
            </Fragment>
          ))}
        </div>
        <button type="button" className="btn-chip" onClick={() => app.notify('Создание ролей появится с полноценным бэкендом')}>
          <Icon name="plus" size={16} />
          Создать роль
        </button>
        <div className="overline roles-overline">По умолчанию</div>
        <div className="roles-list">
          <RoleRow role={everyone} count={countOf(everyone)} on={locked} onClick={() => setSelected('everyone')} />
        </div>
      </section>

      <div className="roles-editor">
        <section className="roles-panel">
          <h3>Роль</h3>
          <label className="auth-field">
            <span className="field-label">Название роли</span>
            <input
              className="input role-input"
              style={{ color: role.color }}
              value={role.name}
              maxLength={32}
              disabled={locked}
              onChange={(e) => update({ name: e.target.value })}
            />
          </label>
          <div className="role-colors">
            <span className="field-label">Цвет</span>
            <div className="swatches">
              {ROLE_SWATCHES.map((c) => (
                <button
                  type="button"
                  key={c}
                  aria-label={'Цвет ' + c}
                  className={'swatch' + (role.color === c ? ' on' : '')}
                  style={{ background: c }}
                  disabled={locked}
                  onClick={() => update({ color: c })}
                />
              ))}
            </div>
          </div>
        </section>
        <div className="overline roles-overline">Права</div>
        <section className="perms-panel">
          {PERMISSIONS.map((p, i) => (
            <Fragment key={p.id}>
              {i > 0 && <div className="roles-divider" />}
              <div className="perm-row">
                <div className="perm-text">
                  <b>{p.title}</b>
                  <span>{p.text}</span>
                </div>
                <Toggle on={role.perms[p.id]} onChange={(v) => update({ perms: { ...role.perms, [p.id]: v } })} />
              </div>
            </Fragment>
          ))}
        </section>
      </div>
    </div>
  );
}
