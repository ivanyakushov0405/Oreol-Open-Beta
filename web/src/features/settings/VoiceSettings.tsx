import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { canPickOutput, readLevel, SENS_MAX, SENS_MIN, setAudioPrefs, useAudioPrefs } from '../../shared/audio/audioPrefs';
import { playSound } from '../../shared/audio/sounds';
import { Icon } from '../../shared/icons';
import { MIC_TEST_EVENT } from '../voice/useVoice';
import { Toggle } from './Toggle';

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
  const opts = [{ id: '', label: 'По умолчанию (системное)' }, ...list.map((d, i) => ({ id: d.deviceId, label: d.label || `${word} ${i + 1}` }))];
  const cur = opts.find((o) => o.id === value) ?? opts[0];
  const btn = useRef<HTMLButtonElement>(null);
  const tap = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; w: number; up: boolean } | null>(null);
  const open = () => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const h = Math.min(opts.length * 44 + 12, 320);
    const up = r.bottom + 6 + h > innerHeight - 12 && r.top - 6 - h > 12;
    setMenu({ x: r.left, y: up ? r.top - 6 - h : r.bottom + 6, w: r.width, up });
  };
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    // прокрутка самого списка его не закрывает — только прокрутка страницы под ним
    const onScroll = (e: Event) => {
      if (e.target instanceof Element && e.target.closest('.select-menu')) return;
      close();
    };
    // Escape закрывает только список, а не весь экран настроек (ловим раньше общего обработчика)
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      close();
    };
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [menu]);
  return (
    <div className="select">
      {/* Свой список вместо системного <select>: системный рисуется ОС и не бывает стеклянным */}
      <button
        ref={btn}
        type="button"
        className={'input select-btn' + (menu ? ' open' : '')}
        aria-haspopup="listbox"
        aria-expanded={!!menu}
        onClick={() => (menu ? setMenu(null) : open())}
      >
        <span>{cur.label}</span>
      </button>
      <Icon name="chevron-down" size={18} />
      {menu &&
        createPortal(
          <>
            <div className="popover-backdrop" onClick={() => setMenu(null)} />
            <div
              className={'select-menu' + (menu.up ? ' up' : '')}
              role="listbox"
              style={{ left: menu.x, top: menu.y, width: menu.w }}
              // палец, который листал список, а не нажимал, ничего не выбирает
              onPointerDown={(e) => (tap.current = { x: e.clientX, y: e.clientY, moved: false })}
              onPointerMove={(e) => {
                const t = tap.current;
                if (t && Math.hypot(e.clientX - t.x, e.clientY - t.y) > 8) t.moved = true;
              }}
              onScroll={() => tap.current && (tap.current.moved = true)}
            >
              {opts.map((o) => (
                <button
                  key={o.id || 'default'}
                  type="button"
                  role="option"
                  aria-selected={o.id === cur.id}
                  className={'select-opt' + (o.id === cur.id ? ' on' : '')}
                  onClick={() => {
                    if (tap.current?.moved) return;
                    onChange(o.id);
                    setMenu(null);
                  }}
                >
                  <span>{o.label}</span>
                  {o.id === cur.id && <Icon name="check" size={16} />}
                </button>
              ))}
            </div>
          </>,
          document.body,
        )}
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

export function VoiceDevices() {
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

  // На время проверки микрофон в звонке выключается (см. MIC_TEST_EVENT в useVoice)
  useEffect(() => {
    window.dispatchEvent(new CustomEvent(MIC_TEST_EVENT, { detail: testing }));
    return () => {
      if (testing) window.dispatchEvent(new CustomEvent(MIC_TEST_EVENT, { detail: false }));
    };
  }, [testing]);

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
              ? 'Нет доступа к микрофону. Разрешите его в настройках браузера'
              : name === 'NotFoundError'
                ? 'Микрофон не найден. Подключите устройство ввода'
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
      setErr('Нет доступа к микрофону. Разрешите его в настройках браузера');
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
                Этот браузер не умеет выбирать динамики, звук идёт в системное устройство
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
              {testing ? 'Говорите: вы слышите себя так, как вас слышат другие' : 'Скажите что-нибудь и послушайте себя в наушниках'}
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
                ? 'Определяется автоматически, фоновый шум подавляет браузер'
                : 'Звук тише порога не передаётся. Зелёная полоса: голос проходит'}
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


export function CameraSettings() {
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
          setErr('Нет доступа к камере. Разрешите её в настройках браузера');
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

export function SoundSettings() {
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
