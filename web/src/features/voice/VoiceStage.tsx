import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { AppState } from '../../app/useAppState';
import { Icon, StrikeIcon } from '../../shared/icons';
import { Avatar } from '../../shared/ui/Avatar';
import { DisplayName } from '../members/Nick';
import { userMenuProps } from '../members/userMenu';
import { openProfile } from '../profile/profile';
import { VideoView } from './VideoView';
import { requestFlip, useFacing } from './camFacing';
import { IS_MOBILE_DEVICE } from './useVoice';
import { animClass, usePeerAnim, type Anim } from './peerAnim';
import type { VoicePeer } from './useVoice';
import { plural, t } from '../../shared/i18n';

export function PeerFlags({ p, order }: { p: VoicePeer; order: 'tile' | 'row' }) {
  const media = (
    <>
      {(p.camera || p.camOn) && <Icon name="video" size={16} />}
      {order === 'row' && (p.screen || p.screenOn) && <Icon name="screen-share" size={16} />}
    </>
  );
  const audio = (
    <>
      {p.deafened && <Icon name="headphones-off" size={16} className="off" />}
      {p.micMuted && <Icon name="mic-off" size={16} className="off" />}
    </>
  );
  if (order === 'tile') {
    return (
      <>
        {p.micMuted && <Icon name="mic-off" size={16} className="off" />}
        {p.deafened && <Icon name="headphones-off" size={16} className="off" />}
        {(p.camera || p.camOn) && <Icon name="video" size={16} />}
      </>
    );
  }
  return (
    <>
      {media}
      {audio}
    </>
  );
}

/**
 * Fullscreen video (screen share or camera): standard fullscreen, or the system video player on iPhone,
 * which has no fullscreen for regular elements.
 */
function openFullscreen(tile: HTMLElement) {
  const video = tile.querySelector('video') as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
  if (!video) return;
  if (tile.requestFullscreen && document.fullscreenEnabled) {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void tile.requestFullscreen().catch(() => video.webkitEnterFullscreen?.());
    return;
  }
  video.webkitEnterFullscreen?.();
}

function Tile({ p, kind, wide, span, avatar = 80, anim }: { p: VoicePeer; kind: 'cam' | 'screen'; wide?: boolean; span?: boolean; avatar?: number; anim?: Anim }) {
  const track = kind === 'screen' ? p.screen : p.camera;
  const hasFlags = kind === 'screen' || p.micMuted || p.deafened || Boolean(p.camera);
  const facing = useFacing();
  const canFlip = IS_MOBILE_DEVICE && p.isLocal && kind === 'cam' && Boolean(track);
  const label = (
    <>
      <span className="nick">
        {p.mobile && kind === 'cam' && <Icon name="smartphone" size={14} className="dev-phone" />}
        <DisplayName name={p.identity} />
      </span>
      {hasFlags && <i className="dot" />}
      {kind === 'screen' ? <Icon name="screen-share" size={16} /> : <PeerFlags p={p} order="tile" />}
    </>
  );
  return (
    <div
      className={'tile' + (p.speaking && kind === 'cam' ? ' speaking' : '') + (track ? '' : ' novideo') + (wide ? ' wide' : '') + (span ? ' span' : '') + animClass(anim)}
      {...userMenuProps(p.identity)}
      onClick={(e) => (track ? openFullscreen(e.currentTarget) : openProfile(p.identity))}
    >
      {track ? (
        <>
          <VideoView track={track} mirror={p.isLocal && kind === 'cam' && facing === 'user'} contain={kind === 'screen'} />
          <div className="shade" />
          {canFlip && (
            <button
              type="button"
              className="tile-flip"
              title={t('Сменить камеру')}
              onClick={(e) => {
                e.stopPropagation();
                requestFlip();
              }}
            >
              <Icon name="camera-flip" size={22} />
            </button>
          )}
          <span
            className="tile-pill"
            onClick={(e) => {
              e.stopPropagation();
              openProfile(p.identity);
            }}
          >
            {label}
          </span>
        </>
      ) : (
        <>
          <div className="tile-media">
            <Avatar name={p.identity} size={avatar} />
          </div>
          <span className="tile-label">{label}</span>
        </>
      )}
    </div>
  );
}

export function VoiceControls({ app, full }: { app: AppState; full?: boolean }) {
  const v = app.voice;
  return (
    <div className="controls">
      {full && (
        <>
          <button className={'ctrl' + (v.micOn ? '' : ' off')} title={v.micOn ? t('Выключить микрофон') : t('Включить микрофон')} onClick={v.toggleMic}>
            <StrikeIcon name="mic" off={!v.micOn} size={30} />
          </button>
          <button className={'ctrl' + (v.deafened ? ' off' : '')} title={v.deafened ? t('Включить звук') : t('Выключить звук')} onClick={v.toggleDeafen}>
            <StrikeIcon name="headphones" off={v.deafened} size={30} />
          </button>
        </>
      )}
      <button className={'ctrl' + (v.cameraOn ? ' on' : '')} title={v.cameraOn ? t('Выключить камеру') : t('Включить камеру')} onClick={v.toggleCamera}>
        <Icon name={v.cameraOn ? 'video' : 'video-off'} size={30} />
      </button>
      <button
        className={'ctrl' + (v.screenOn ? ' share-on' : '')}
        title={v.screenOn ? t('Остановить демонстрацию') : t('Демонстрация экрана')}
        onClick={v.toggleScreen}
      >
        <Icon name={v.screenOn ? 'screen-share-stop' : 'screen-share'} size={30} />
      </button>
      <button className="ctrl leave" title={t('Отключиться')} onClick={v.leave}>
        <Icon name="phone-off" size={30} />
      </button>
    </div>
  );
}

const TILE_RATIO = 210 / 196;
const TILE_GAP = 16;
/**
 * Last computed tile size within one connection: the stage remounts when switching channels, so reuse it instead
 * of growing the tiles every time. The grow animation only plays on the first show after connecting.
 */
let tileCache: { session: number; count: number; w: number; h: number } | null = null;

function useTileSize(count: number, enabled: boolean, session: number | null) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(() =>
    enabled && tileCache && tileCache.session === session && tileCache.count === count ? { w: tileCache.w, h: tileCache.h } : null,
  );
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !enabled || count === 0) {
      setSize(null);
      return;
    }
    const calc = () => {
      const W = el.clientWidth;
      const H = el.clientHeight;
      if (!W || !H) return;
      let best = 0;
      for (let cols = 1; cols <= count; cols++) {
        const rows = Math.ceil(count / cols);
        const byW = (W - TILE_GAP * (cols - 1)) / cols;
        const byH = ((H - TILE_GAP * (rows - 1)) / rows) * TILE_RATIO;
        best = Math.max(best, Math.min(byW, byH));
      }
      const w = Math.floor(Math.max(150, Math.min(best, 720)));
      const h = Math.floor(w / TILE_RATIO);
      if (session !== null) tileCache = { session, count, w, h };
      setSize((s) => (s && s.w === w && s.h === h ? s : { w, h }));
    };
    calc();
    const ro = new ResizeObserver(calc);
    ro.observe(el);
    return () => ro.disconnect();
  }, [count, enabled, session]);
  return { ref, size };
}

export function VoiceStage({ app, mobile }: { app: AppState; mobile?: boolean }) {
  const v = app.voice;
  const here = app.inVoiceHere;
  const screens = v.peers.filter((p) => p.screen);
  // While connecting to this channel show the final layout right away (tiles and buttons) instead of a "Connecting"
  // card, otherwise the content changed abruptly mid-slide and the tiles appeared again.
  const joining = here && v.state === 'connecting';
  const live = here && (v.state === 'connected' || joining);
  const livePeers = joining ? app.voiceUsers : v.peers;
  const preview = live ? [] : app.voiceUsers;
  const count = live ? livePeers.length + screens.length : preview.length;
  const { ref, size } = useTileSize(count, !mobile && (live || preview.length > 0), v.startedAt);
  // The key does not depend on the connection, so people already shown do not reappear when we join.
  const peerTiles = usePeerAnim(live ? livePeers : preview, (p) => p.identity, `${app.server.id}:${app.voiceSource}`, 1500);
  const screenTiles = usePeerAnim(live ? screens : [], (p) => p.identity, app.server.id);
  if (!live && preview.length > 0) {
    const other = v.state !== 'idle' && !here ? app.serverById(v.server)?.name ?? null : null;
    const connecting = here && v.state === 'connecting';
    const avatarP = size ? Math.round(Math.min(160, Math.max(56, size.w * 0.38))) : 80;
    return (
      <>
        <div
          className="tiles preview"
          data-n={mobile ? Math.min(count, 7) : undefined}
          ref={ref}
          style={size ? ({ '--tile-w': `${size.w}px`, '--tile-h': `${size.h}px`, '--tile-s': Math.min(1.7, Math.max(0.85, size.w / 210)).toFixed(3) } as CSSProperties) : undefined}
        >
          {peerTiles.map((t) => (
            <Tile key={t.key} p={{ ...t.item, camera: undefined, screen: undefined }} anim={t.anim} kind="cam" avatar={mobile ? 80 : avatarP} />
          ))}
        </div>
        <div className="controls-bar">
          <div className="join-bar glass">
            <span className="jb-text">
              {connecting
                ? t('Подключаемся…')
                : v.error ?? (other ? t('Вы в голосовом канале «{0}»', { 0: other }) : t('{0} в Лобби', { 0: plural(preview.length, 'участник', 'участника', 'участников') }))}
            </span>
            {!connecting && (
              <button className="btn btn-primary" onClick={app.joinVoice}>
                <Icon name="voice" size={20} />
                {v.error ? t('Повторить') : other ? t('Перейти сюда') : t('Подключиться')}
              </button>
            )}
          </div>
        </div>
      </>
    );
  }
  if (!live) {
    const other = v.state !== 'idle' && !here ? app.serverById(v.server)?.name ?? null : null;
    return (
      <div className="join-card">
        <div className={'big' + (here && v.state === 'connecting' ? ' pulse' : '')}>
          <Icon name="voice" size={32} />
        </div>
        <h3>{t('Лобби')}</h3>
        {here && v.state === 'connecting' ? (
          <p>{t('Подключаемся к голосовому каналу…')}</p>
        ) : (
          <>
            <p>{v.error ?? (other ? t('Вы в голосовом канале сервера «{0}»', { 0: other }) : t('Вы не в голосовом канале'))}</p>
            <button className="btn btn-primary" onClick={app.joinVoice} style={{ height: 44, padding: '0 24px' }}>
              <Icon name="voice" size={20} />
              {v.error ? t('Повторить') : other ? t('Перейти сюда') : t('Подключиться')}
            </button>
          </>
        )}
      </div>
    );
  }
  const avatar = size ? Math.round(Math.min(160, Math.max(56, size.w * 0.38))) : 80;
  // With an odd number of people (3, 5) the first person spans the full width, leaving no empty half next to the last one.
  const people = peerTiles.length;
  const personTiles = peerTiles.map((t, i) => (
    <Tile key={t.key} p={t.item} anim={t.anim} kind="cam" avatar={mobile ? 80 : avatar} span={mobile && i === 0 && (people === 3 || people === 5)} />
  ));
  const shares = screenTiles.map((t) => <Tile key={t.key + ':screen'} p={t.item} anim={t.anim} kind="screen" wide={mobile} />);
  const tiles: ReactNode[] = mobile ? [...shares, ...personTiles] : [...personTiles, ...shares];
  return (
    <>
      <div
        className="tiles"
        data-n={mobile ? Math.min(Math.max(1, people), 7) : undefined}
        ref={ref}
        style={size ? ({ '--tile-w': `${size.w}px`, '--tile-h': `${size.h}px`, '--tile-s': Math.min(1.7, Math.max(0.85, size.w / 210)).toFixed(3) } as CSSProperties) : undefined}
      >
        {tiles}
      </div>
      <div className="controls-bar">
        <VoiceControls app={app} full={mobile} />
      </div>
    </>
  );
}
