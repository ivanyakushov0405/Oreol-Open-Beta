import { useLayoutEffect, useRef, useState } from 'react';
import type { AppState } from '../../app/useAppState';
import { pingClass, QUALITY_TITLE, SignalIcon, useElapsed } from '../../features/voice/VoiceStatus';
import { useMicLevel } from '../../features/voice/micLevel';
import { Icon, StrikeIcon } from '../../shared/icons';
import { t } from '../../shared/i18n';

export const PILL_SPACE = 40;

export function MobileCall({
  app,
  gone,
  min,
  onMin,
  onOpen,
  onOpenHere,
  onMore,
  onMeasure,
  liveMic,
}: {
  app: AppState;
  gone: boolean;
  min: boolean;
  onMin: () => void;
  onOpen: () => void;
  onOpenHere: () => void;
  onMore: (btn: HTMLElement) => void;
  onMeasure: (h: number | null, drag: number | null) => void;
  liveMic: boolean;
}) {
  const v = app.voice;
  const micBtn = useRef<HTMLButtonElement>(null);
  useMicLevel(micBtn, liveMic && v.micOn && v.state === 'connected', v.micTrack);
  const elapsed = useElapsed(v.startedAt);
  const box = useRef<HTMLDivElement>(null);
  const [h, setH] = useState<number | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const grab = useRef<{ y: number; moved: boolean } | null>(null);
  const idle = v.state === 'idle';
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const update = () => setH(el.offsetHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [idle]);
  useLayoutEffect(() => onMeasure(idle ? null : h, drag), [idle, h, drag]); // eslint-disable-line react-hooks/exhaustive-deps
  if (idle) return null;
  const srv = app.serverById(v.server);
  const ch = srv?.channels.find((c) => c.kind === 'voice');
  const connecting = v.state === 'connecting';
  const q = connecting ? 'q-medium' : `q-${v.quality}`;
  const shut = gone || min;
  const end = (y: number | null) => {
    const g = grab.current;
    grab.current = null;
    setDrag(null);
    if (!g || y == null) return;
    // A short tap or a flick up by a fifth of the height collapses it.
    if (!g.moved || y - g.y < -(h ?? 120) * 0.2) onMin();
  };
  return (
    <div
      className={'m-call-wrap' + (shut ? ' shut' : '') + (drag != null ? ' dragging' : '')}
      aria-hidden={shut || undefined}
    >
      <div className="m-call-box" ref={box} style={drag != null && h ? ({ '--drag-op': Math.max(0.15, 1 + (1.4 * drag) / h), transform: `translateY(${drag * 0.35}px)` } as React.CSSProperties) : undefined}>
        <div className="m-call glass">
          <div className="m-call-top">
            <span className={'m-call-signal ' + q} title={v.rtt != null ? t('Пинг {0} мс', { 0: v.rtt }) : undefined}>
              <SignalIcon size={24} />
            </span>
            <button className="m-call-text" onClick={onOpenHere} title={t('Открыть голосовой канал')} tabIndex={shut ? -1 : undefined}>
              <span className="t">
                <b className={'st ' + q}>{connecting ? t('Подключение…') : QUALITY_TITLE[v.quality]}</b>
                {!connecting && <span className={'ping ' + pingClass(v.rtt, v.quality)}>{v.rtt != null ? t('{0} мс', { 0: v.rtt }) : t('… мс')}</span>}
                <span className="where">
                  <span className="ch">{ch?.name ?? t('Голосовой')}</span>
                  {srv?.name && <span className="sv">{srv.name}</span>}
                </span>
              </span>
              <span className="s">
                {v.peers.length}{t(' в канале')}
                {elapsed && ` · ${elapsed}`}
              </span>
            </button>
            <button className="m-call-back" title={t('Вернуться в голосовой канал')} aria-label={t('Вернуться в голосовой канал')} onClick={onOpen}>
              <Icon name="expand" size={20} />
            </button>
          </div>
          <div className="m-call-ctrls">
            <button className={'m-call-btn' + (v.cameraOn ? ' on' : '')} title={v.cameraOn ? t('Выключить камеру') : t('Включить камеру')} onClick={v.toggleCamera}>
              <Icon name={v.cameraOn ? 'video' : 'video-off'} size={22} />
            </button>
            <button
              ref={micBtn}
              className={'m-call-btn mic-lvl' + (v.micOn ? '' : ' off')}
              title={v.micOn ? t('Выключить микрофон') : t('Включить микрофон')}
              onClick={() => void v.toggleMic()}
            >
              <StrikeIcon name="mic" off={!v.micOn} size={22} />
              {liveMic && v.micOn && <Icon name="mic" size={22} className="mic-fill" />}
            </button>
            <button className={'m-call-btn' + (v.deafened ? ' off' : '')} title={v.deafened ? t('Включить звук') : t('Выключить звук')} onClick={v.toggleDeafen}>
              <StrikeIcon name="headphones" off={v.deafened} size={22} />
            </button>
            <button className="m-call-btn" title={t('Ещё')} aria-label={t('Ещё')} onClick={(e) => onMore(e.currentTarget)}>
              <Icon name="more" size={22} />
            </button>
            <button className="ctrl leave m-call-leave" title={t('Отключиться')} aria-label={t('Отключиться')} onClick={v.leave}>
              <Icon name="phone-off" size={22} />
            </button>
          </div>
          <div
            className="m-call-grab"
            role="button"
            tabIndex={0}
            aria-label={t('Свернуть виджет')}
            title={t('Потяните вверх, чтобы свернуть')}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onMin()}
            onPointerDown={(e) => {
              grab.current = { y: e.clientY, moved: false };
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              const g = grab.current;
              if (!g) return;
              const dy = e.clientY - g.y;
              if (Math.abs(dy) > 4) g.moved = true;
              if (g.moved) setDrag(Math.min(0, dy));
            }}
            onPointerUp={(e) => end(e.clientY)}
            onPointerCancel={() => end(null)}
          >
            <i />
          </div>
        </div>
      </div>
    </div>
  );
}

export function MobileCallPill({ app, shown, onExpand }: { app: AppState; shown: boolean; onExpand: () => void }) {
  const v = app.voice;
  if (v.state === 'idle') return null;
  const srv = app.serverById(v.server);
  const ch = srv?.channels.find((c) => c.kind === 'voice');
  const q = v.state === 'connecting' ? 'q-medium' : `q-${v.quality}`;
  return (
    <button className={'m-call-pill' + (shown ? '' : ' gone')} onClick={onExpand} title={t('Развернуть виджет звонка')} tabIndex={shown ? undefined : -1} aria-hidden={shown ? undefined : true}>
      <span className={'sig ' + q}>
        <SignalIcon size={16} />
      </span>
      <span className="txt">
        <span className="ch">{ch?.name ?? t('Голосовой')}</span>
        {srv?.name && <span className="sv">{srv.name}</span>}
      </span>
    </button>
  );
}

