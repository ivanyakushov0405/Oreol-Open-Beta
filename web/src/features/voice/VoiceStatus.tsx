import { useEffect, useState } from 'react';
import type { AppState } from '../../app/useAppState';
import { Icon } from '../../shared/icons';

/* ---------- Статус голосового подключения ---------- */
const QUALITY = {
  good: { title: 'Подключено', icon: 'wifi' },
  medium: { title: 'Связь нестабильна', icon: 'wifi' },
  bad: { title: 'Плохое соединение', icon: 'wifi' },
} as const;

/** Пинг выше этого — показываем его рядом со статусом, даже если LiveKit считает связь хорошей. */
export const HIGH_PING = 200;

/** Цвет пинга: зелёный, жёлтый (≥ 120 мс) или красный (≥ HIGH_PING). */
export function pingClass(rtt: number | null, quality: 'good' | 'medium' | 'bad') {
  if (quality === 'bad' || (rtt != null && rtt >= HIGH_PING)) return 'q-bad';
  if (quality === 'medium' || (rtt != null && rtt >= 120)) return 'q-medium';
  return 'q-good';
}

export const QUALITY_TITLE = { good: 'Подключено', medium: 'Связь нестабильна', bad: 'Плохое соединение' } as const;

export function useElapsed(from: number | null) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!from) return;
    const id = window.setInterval(() => tick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [from]);
  if (!from) return '';
  const s = Math.floor((Date.now() - from) / 1000);
  const mm = String(Math.floor(s / 60) % 60).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Индикатор связи из макета: точка и три дуги. */
export function SignalIcon({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 22 22" fill="none" aria-hidden="true">
      <circle cx="10.5" cy="17.5" r="1.5" fill="currentColor" />
      <path d="M8 15c1.5-1.2 3.5-1.2 5 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M5.8 12C8.6 9.7 12.4 9.7 15.2 12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M3.3 8.8C7.6 5.3 13.4 5.3 17.7 8.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function VoiceStatus({ app, onOpen }: { app: AppState; onOpen: () => void }) {
  const v = app.voice;
  if (v.state === 'idle') return null;
  const q = v.state === 'connecting' ? null : QUALITY[v.quality];
  const cls = v.state === 'connecting' ? 'q-medium' : `q-${v.quality}`;
  return (
    <div className="voice-status">
      <span className={'signal ' + cls} tabIndex={0} aria-label={v.rtt != null ? `Пинг ${v.rtt} мс` : 'Пинг измеряется'}>
        <SignalIcon />
        <span className="ping-tip" role="tooltip">
          {v.state === 'connecting' ? (
            'Подключение…'
          ) : (
            <>
              Пинг: <b className={cls}>{v.rtt != null ? `${v.rtt} мс` : 'измеряется…'}</b>
            </>
          )}
        </span>
      </span>
      <button className="text" onClick={onOpen}>
        <span className={'title ' + cls}>
          {q ? q.title : 'Подключение…'}
          {/* Пинг обычно — подсказкой на значке; при плохой связи или большом пинге — сразу после статуса */}
          {q && v.rtt != null && (v.quality === 'bad' || v.rtt >= HIGH_PING) && <b className={'vs-ping ' + pingClass(v.rtt, v.quality)}>{v.rtt} мс</b>}
        </span>
        <span className="sub">
          {app.serverById(v.server)?.channels.find((c) => c.kind === 'voice')?.name ?? 'Голосовой'} / {app.serverById(v.server)?.name}
        </span>
      </button>
      <button className="disconnect" title="Отключиться" aria-label="Отключиться" onClick={v.leave}>
        <Icon name="phone-off" size={20} />
      </button>
    </div>
  );
}
