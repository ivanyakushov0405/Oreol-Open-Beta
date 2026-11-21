import { useEffect, useLayoutEffect, useReducer, useRef, useState, type CSSProperties, type MouseEvent as RMouseEvent, type ReactNode } from 'react';
import { userMenuProps } from './userMenu';
import { createPortal } from 'react-dom';
import type { AppState } from './App';
import { Icon, LogoPeople, StrikeIcon } from './icons';
import { useMicLevel } from './micLevel';
import { handleOf, type Channel, type ServerId, type Status } from './mock';
import { useVoiceCounts, type VoicePeer } from './useVoice';
import { Avatar, Banner, DisplayName, VideoView, mentionsMe } from './ui';


/** Анимация входа/выхода участников голосового: новые помечаются «in», ушедшие ещё ~0.25 с
 *  остаются на своём месте с пометкой «out», чтобы успеть плавно исчезнуть.
 *  scope — смена сервера/подключения: тогда ничего не анимируем, просто показываем новый список. */
const PEER_ANIM_MS = 260;
type Anim = 'in' | 'out' | undefined;
function usePeerAnim<T>(items: T[], keyOf: (t: T) => string, scope: string, settleMs = 0): { item: T; key: string; anim: Anim }[] {
  const st = useRef<{ scope: string | null; at: number; prev: T[]; seen: Set<string>; fresh: Map<string, number>; ghosts: Map<string, { item: T; idx: number; at: number }> }>({
    scope: null,
    at: 0,
    prev: [],
    seen: new Set(),
    fresh: new Map(),
    ghosts: new Map(),
  });
  const [, tick] = useReducer((x: number) => x + 1, 0);
  const s = st.current;
  const now = Date.now();
  const keys = items.map(keyOf);
  const keySet = new Set(keys);
  if (s.scope !== scope) {
    // первый показ или другой сервер — без анимаций
    s.scope = scope;
    s.at = now;
    s.seen = new Set(keys);
    s.fresh.clear();
    s.ghosts.clear();
  } else if (now - s.at < settleMs || (s.prev.length === 0 && items.length > 0)) {
    // сразу после смены источника списка (вошли/вышли из канала сами) список «доезжает» — без анимаций;
    // так же и когда список пришёл впервые (участники сервера подгружаются после открытия канала)
    // сразу после смены источника списка (вошли/вышли из канала сами) список «доезжает» — без анимаций
    s.seen = new Set(keys);
    s.ghosts.clear();
  } else {
    s.prev.forEach((it, i) => {
      const k = keyOf(it);
      if (!keySet.has(k) && !s.ghosts.has(k)) s.ghosts.set(k, { item: it, idx: i, at: now });
    });
    for (const k of keys) {
      if (s.ghosts.has(k)) s.ghosts.delete(k); // вернулся, пока исчезал
      if (!s.seen.has(k)) {
        s.seen.add(k);
        s.fresh.set(k, now);
      }
    }
    for (const k of [...s.seen]) if (!keySet.has(k)) s.seen.delete(k);
  }
  s.prev = items;
  for (const [k, at] of s.fresh) if (now - at > PEER_ANIM_MS) s.fresh.delete(k);
  for (const [k, g] of s.ghosts) if (now - g.at > PEER_ANIM_MS) s.ghosts.delete(k);

  const pending = s.fresh.size + s.ghosts.size;
  useEffect(() => {
    if (!pending) return;
    const id = window.setTimeout(tick, PEER_ANIM_MS + 20);
    return () => window.clearTimeout(id);
  });

  const out: { item: T; key: string; anim: Anim }[] = items.map((item, i) => ({ item, key: keys[i], anim: s.fresh.has(keys[i]) ? 'in' : undefined }));
  [...s.ghosts.entries()]
    .sort((a, b) => a[1].idx - b[1].idx)
    .forEach(([k, g]) => out.splice(Math.min(g.idx, out.length), 0, { item: g.item, key: k, anim: 'out' }));
  return out;
}
const animClass = (a: Anim) => (a === 'in' ? ' peer-in' : a === 'out' ? ' peer-out' : '');

/* ---------- Рейл серверов ---------- */
export function Rail({
  app,
  home,
  onHome,
  onServer,
  noHome,
}: {
  app: AppState;
  home: boolean;
  onHome: () => void;
  onServer: (id: ServerId) => void;
  noHome?: boolean;
}) {
  const inVoice = app.voice.state === 'connected';
  // Метка «в войсе N» над каждым сервером, где кто-то сидит (а не только где сидим мы)
  const counts = useVoiceCounts(app.servers.map((s) => s.id));
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);
  const hover = (text: string) => ({
    onMouseEnter: (e: RMouseEvent<HTMLElement>) => {
      const r = e.currentTarget.getBoundingClientRect();
      setTip({ text, x: r.right + 14, y: r.top + r.height / 2 });
    },
    onMouseLeave: () => setTip(null),
  });
  return (
    <nav className="rail glass" onScroll={() => setTip(null)}>
      {/* На телефоне личные сообщения — вкладка «Чаты» в таб-панели, на рейле их нет */}
      {!noHome && (
        <>
          <button className={'rail-home' + (home ? ' on' : '')} aria-label="Личные сообщения" onClick={onHome} {...hover('Личные сообщения')}>
            <LogoPeople size={30} />
          </button>
          <div className="rail-sep" />
        </>
      )}
      {app.servers.map((s) => {
        const n = inVoice && app.voice.server === s.id ? app.voice.peers.length : counts[s.id] ?? 0;
        return (
        <button
          key={s.id}
          className={'server-icon' + (s.id === app.serverId && !home ? ' on' : '')}
          style={{ background: s.gradient }}
          aria-label={s.name}
          {...hover(s.name)}
          onClick={() => onServer(s.id)}
        >
          {s.short}
          {n > 0 && (
            <span className={'voice-badge' + (inVoice && app.voice.server === s.id ? ' mine' : '')}>
              <Icon name="mic" size={12} />
              {n}
            </span>
          )}
        </button>
        );
      })}
      <button
        className="rail-add"
        aria-label="Создать сервер"
        {...hover('Создать сервер')}
        onClick={() => app.notify('Создание серверов появится с полноценным бэкендом')}
      >
        <Icon name="plus" />
      </button>
      {tip &&
        createPortal(
          <div className="rail-tip" style={{ left: tip.x, top: tip.y }} key={tip.text}>
            {tip.text}
          </div>,
          document.body,
        )}
    </nav>
  );
}

/* ---------- Список каналов ---------- */
export function VoiceUserRow({ p, anim }: { p: VoicePeer; anim?: Anim }) {
  return (
    <div className={'voice-user' + animClass(anim)} {...userMenuProps(p.identity)}>
      <Avatar name={p.identity} size={28} speaking={p.speaking} />
      <span className={'name' + (p.speaking ? ' speaking' : '')}>
        {p.mobile && <Icon name="smartphone" size={14} className="dev-phone" />}
        <DisplayName name={p.identity} />
      </span>
      {/* Иконки прижаты вправо, слева направо: видео → демонстрация → наушники → микрофон */}
      <span className="flags">
        <PeerFlags p={p} order="row" />
      </span>
    </div>
  );
}

/** Сколько чужих сообщений пришло после последнего прочитанного. */
/** Красный бейдж непрочитанного: при каждом новом числе — «выпрыгивает»; больше 99 — «99+». */
export function UnreadBadge({ n, className = '' }: { n: number; className?: string }) {
  if (!n) return null;
  return (
    <span key={n} className={'badge unread-badge ' + className} aria-label={`Непрочитанных: ${n}`}>
      {n > 99 ? '99+' : n}
    </span>
  );
}
/** Сколько непрочитанных в чате (чужие сообщения после отметки «прочитано»). */
export function chatUnread(app: AppState, chat: AppState['lobby']) {
  return unreadCount(chat.messages, chat.myRead, app.name);
}

/** Сколько непрочитанных сообщений упоминают тебя. */
function unreadMentions(messages: { id: string | number; user: string; sys?: string | null; content?: string | null }[], readId: number, me: string) {
  const tag = handleOf(me);
  let n = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (Number(m.id) <= readId) break;
    if (!m.sys && m.user !== me && mentionsMe(m.content || '', tag)) n++;
  }
  return n;
}

function unreadCount(messages: { id: string | number; user: string; sys?: string | null }[], readId: number, me: string) {
  let n = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (Number(m.id) <= readId) break;
    if (!m.sys && m.user !== me) n++;
  }
  return n;
}

export function ChannelList({
  app,
  active,
  onOpen,
}: {
  app: AppState;
  active: string | null;
  onOpen: (c: Channel) => void;
}) {
  const text = app.server.channels.filter((c) => c.kind === 'text');
  const voice = app.server.channels.filter((c) => c.kind === 'voice');
  // Анимация — только когда кто-то сам зашёл/вышел; при своём входе/выходе список меняет источник и не «прыгает»
  const voiceRows = usePeerAnim(app.voiceUsers, (p) => p.identity, `${app.server.id}:${app.voiceSource}`, 1500);
  // Непрочитанное: красный бейдж с числом (первый текстовый канал — общий чат, голосовой — его чат)
  const badge = (c: Channel, i: number) => {
    const chat = c.kind === 'voice' ? app.lobby : i === 0 ? app.general : null;
    if (!chat || active === c.id) return null;
    const n = unreadCount(chat.messages, chat.myRead, app.name);
    if (!n) return null;
    const at = unreadMentions(chat.messages, chat.myRead, app.name);
    return (
      <span className="ch-badges">
        {at > 0 && (
          <span key={'@' + at} className="badge unread-badge mention-badge" title={`Упоминаний: ${at}`}>
            @
          </span>
        )}
        <UnreadBadge n={n} />
      </span>
    );
  };
  return (
    <>
      <div className="section-title overline">Текстовые каналы</div>
      {text.map((c) => (
        <button
          key={c.id}
          className={'channel' + (active === c.id ? ' on' : '')}
          onClick={() => onOpen(c)}
        >
          <Icon name="chats" size={18} />
          <span className="name">{c.name}</span>
          {badge(c, text.indexOf(c))}
        </button>
      ))}
      <div className="section-title overline">Голосовые каналы</div>
      {voice.map((c) => (
        <div key={c.id}>
          <button
            className={'channel' + (active === c.id ? ' on' : '') + (app.voiceUsers.length ? ' live' : '') + (app.inVoiceHere ? ' mine' : '')}
            onClick={() => onOpen(c)}
          >
            <Icon name="voice" size={18} />
            <span className="name">{c.name}</span>
            {badge(c, 0)}
          </button>
          {voiceRows.length > 0 && (
            <div className="voice-users">
              {voiceRows.map((r) => (
                <VoiceUserRow key={r.key} p={r.item} anim={r.anim} />
              ))}
            </div>
          )}
        </div>
      ))}
    </>
  );
}

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

/* ---------- Окно аккаунта (Figma «Account menu (open)», Desktop · Direct messages) ---------- */
export const STATUS_ITEMS: { id: Status; label: string }[] = [
  { id: 'online', label: 'В сети' },
  { id: 'idle', label: 'Не активен' },
  { id: 'dnd', label: 'Не беспокоить' },
  { id: 'offline', label: 'Невидимый' },
];

function AccountMenu({
  app,
  onClose,
  onSettings,
  onProfile,
}: {
  app: AppState;
  onClose: () => void;
  onSettings: () => void;
  onProfile: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || (t as Element).closest?.('.user-panel .who')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown);
    };
  }, [onClose]);
  // Позиция: над панелью профиля, левый край на 4px левее неё (как в макете)
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const panel = document.querySelector('.user-panel');
      if (!panel) return;
      const r = panel.getBoundingClientRect();
      setPos({ left: Math.max(8, r.left - 4), bottom: window.innerHeight - r.top + 8 });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, []);
  const soon = (what: string) => {
    onClose();
    app.notify(`${what} появятся вместе с личными сообщениями`);
  };
  if (!pos) return null;
  return createPortal(
    <div className="acct-menu" role="menu" ref={ref} style={{ left: pos.left, bottom: pos.bottom }}>
      <Banner name={app.name} />
      <div className="acct-body">
        <span className="mc-avatar">
          <Avatar name={app.name} size={72} status={app.status} />
        </span>
        <div className="acct-id">
          <h3>{app.me.displayName}</h3>
          <span>{handleOf(app.name)}</span>
        </div>
        <div className="acct-items">
          <div className="acct-over">Статус</div>
          {STATUS_ITEMS.map((s) => (
            <button
              key={s.id}
              role="menuitemradio"
              aria-checked={app.status === s.id}
              className={'acct-item' + (app.status === s.id ? ' on' : '')}
              onClick={() => app.setStatus(s.id)}
            >
              <i className={`acct-dot status-${s.id}`} />
              {s.label}
            </button>
          ))}
          <hr />
          <button role="menuitem" className="acct-item" onClick={() => soon('Друзья')}>
            <Icon name="users" size={18} />
            Друзья
          </button>
          <button role="menuitem" className="acct-item" onClick={() => soon('Запросы в друзья')}>
            <Icon name="plus" size={18} />
            Запросы в друзья
          </button>
          <button role="menuitem" className="acct-item" onClick={onProfile}>
            <Icon name="pencil" size={18} />
            Редактировать профиль
          </button>
          <button role="menuitem" className="acct-item" onClick={onSettings}>
            <Icon name="settings" size={18} />
            Настройки
          </button>
          <hr />
          <button role="menuitem" className="acct-item danger" onClick={app.logout}>
            <Icon name="logout" size={18} />
            Выйти
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ---------- Панель пользователя ---------- */
export function UserPanel({
  app,
  onSettings,
  onProfile,
  onStage = false,
}: {
  app: AppState;
  onSettings: () => void;
  onProfile?: () => void;
  /** Открыт сервер, в войсе которого мы сидим, — нас уже видно (и подсвечивает) в списке каналов, кольца на аватарке не нужно. */
  onStage?: boolean;
}) {
  const v = app.voice;
  const [menu, setMenu] = useState(false);
  // В звонке иконка микрофона заполняется цианом по уровню голоса, а пока говоришь — кольцо вокруг аватарки.
  // Если открыт сервер, в войсе которого сидим, кольца нет: нас уже подсвечивает список каналов.
  const micLive = v.micOn && v.state === 'connected';
  const panel = useRef<HTMLDivElement>(null);
  useMicLevel(panel, micLive, v.micTrack);
  return (
    <div className={'user-panel' + (onStage ? ' on-stage' : '')} ref={panel}>
      {menu && (
        <AccountMenu
          app={app}
          onClose={() => setMenu(false)}
          onSettings={() => {
            setMenu(false);
            onSettings();
          }}
          onProfile={() => {
            setMenu(false);
            (onProfile ?? onSettings)();
          }}
        />
      )}
      <Avatar name={app.name} size={34} status={app.status} />
      <button
        className={'who' + (menu ? ' on' : '')}
        onClick={() => setMenu((m) => !m)}
        title="Статус и аккаунт"
        aria-haspopup="menu"
        aria-expanded={menu}
      >
        <b>{app.me.displayName}</b>
        <span>{handleOf(app.name)}</span>
      </button>
      <button
        className={'icon-btn mic-lvl' + (!v.micOn ? ' danger' : '')}
        title={v.micOn ? 'Выключить микрофон' : 'Включить микрофон'}
        onClick={() => void v.toggleMic()}
      >
        <StrikeIcon name="mic" off={!v.micOn} />
        {micLive && <Icon name="mic" className="mic-fill" />}
      </button>
      <button
        className={'icon-btn' + (v.deafened ? ' danger' : '')}
        title={v.deafened ? 'Включить звук' : 'Выключить звук'}
        onClick={v.toggleDeafen}
      >
        <StrikeIcon name="headphones" off={v.deafened} />
      </button>
      <button className="icon-btn" title="Настройки" onClick={onSettings}>
        <Icon name="settings" />
      </button>
    </div>
  );
}

/* ---------- Текстовый чат: см. ChatBody.tsx ---------- */
export { ChatBody, PinnedButton } from './ChatBody';

/* ---------- Голосовой канал (макет «Desktop · Voice channel») ---------- */
function PeerFlags({ p, order }: { p: VoicePeer; order: 'tile' | 'row' }) {
  const media = (
    <>
      {p.camera && <Icon name="video" size={16} />}
      {order === 'row' && p.screen && <Icon name="screen-share" size={16} />}
    </>
  );
  const audio = (
    <>
      {p.deafened && <Icon name="headphones-off" size={16} className="off" />}
      {p.micMuted && <Icon name="mic-off" size={16} className="off" />}
    </>
  );
  // В строке канала слева направо: видео → демонстрация → наушники → микрофон.
  // На плитке — наоборот (иконки идут от имени): микрофон → наушники → видео.
  if (order === 'tile') {
    return (
      <>
        {p.micMuted && <Icon name="mic-off" size={16} className="off" />}
        {p.deafened && <Icon name="headphones-off" size={16} className="off" />}
        {p.camera && <Icon name="video" size={16} />}
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

function Tile({ p, kind, wide, avatar = 80, anim }: { p: VoicePeer; kind: 'cam' | 'screen'; wide?: boolean; avatar?: number; anim?: Anim }) {
  const track = kind === 'screen' ? p.screen : p.camera;
  const hasFlags = kind === 'screen' || p.micMuted || p.deafened || Boolean(p.camera);
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
      className={'tile' + (p.speaking && kind === 'cam' ? ' speaking' : '') + (track ? '' : ' novideo') + (wide ? ' wide' : '') + animClass(anim)}
      {...userMenuProps(p.identity)}
    >
      {track ? (
        <>
          <VideoView track={track} mirror={p.isLocal && kind === 'cam'} contain={kind === 'screen'} />
          <div className="shade" />
          <span className="tile-pill">{label}</span>
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

/** Нижняя панель: в макете — камера, демонстрация и отбой (микрофон и звук — в панели пользователя).
 *  На телефоне панели пользователя нет, поэтому там добавляем микрофон и звук. */
export function VoiceControls({ app, full }: { app: AppState; full?: boolean }) {
  const v = app.voice;
  return (
    <div className="controls">
      {full && (
        <>
          <button className={'ctrl' + (v.micOn ? '' : ' off')} title={v.micOn ? 'Выключить микрофон' : 'Включить микрофон'} onClick={v.toggleMic}>
            <StrikeIcon name="mic" off={!v.micOn} size={30} />
          </button>
          <button className={'ctrl' + (v.deafened ? ' off' : '')} title={v.deafened ? 'Включить звук' : 'Выключить звук'} onClick={v.toggleDeafen}>
            <StrikeIcon name="headphones" off={v.deafened} size={30} />
          </button>
        </>
      )}
      <button className={'ctrl' + (v.cameraOn ? ' on' : '')} title={v.cameraOn ? 'Выключить камеру' : 'Включить камеру'} onClick={v.toggleCamera}>
        <Icon name={v.cameraOn ? 'video' : 'video-off'} size={30} />
      </button>
      <button
        className={'ctrl' + (v.screenOn ? ' share-on' : '')}
        title={v.screenOn ? 'Остановить демонстрацию' : 'Демонстрация экрана'}
        onClick={v.toggleScreen}
      >
        {/* Во время демонстрации — своя иконка из Figma (Icon/screen-share-stop, зелёная) */}
        <Icon name={v.screenOn ? 'screen-share-stop' : 'screen-share'} size={30} />
      </button>
      <button className="ctrl leave" title="Отключиться" onClick={v.leave}>
        <Icon name="phone-off" size={30} />
      </button>
    </div>
  );
}

/** Подбирает размер плиток под площадь сцены и число участников (пропорции макета 210:196, зазор 16). */
const TILE_RATIO = 210 / 196;
const TILE_GAP = 16;
/** Последний рассчитанный размер плиток в рамках одного подключения: при переходе между каналами
 *  сцена монтируется заново — берём размер отсюда, чтобы плитки не «вырастали» каждый раз.
 *  Анимация роста остаётся только при первом показе после подключения. */
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

function plural(n: number, one: string, few: string, many: string) {
  const a = n % 10, b = n % 100;
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
}

export function VoiceStage({ app, mobile }: { app: AppState; mobile?: boolean }) {
  const v = app.voice;
  const here = app.inVoiceHere;
  const screens = v.peers.filter((p) => p.screen);
  // Пока подключаемся к этому каналу — уже итоговый вид (плитки тех, кто в канале, и кнопки), без промежуточной
  // карточки «Подключаемся…»: иначе посреди выезда экрана содержимое резко менялось и плитки появлялись заново
  const joining = here && v.state === 'connecting';
  const live = here && (v.state === 'connected' || joining);
  const livePeers = joining ? app.voiceUsers : v.peers;
  /** Не в канале, но в нём кто-то есть — показываем их плитки (без видео) и панель «Подключиться». */
  const preview = live ? [] : app.voiceUsers;
  const count = live ? livePeers.length + screens.length : preview.length;
  const { ref, size } = useTileSize(count, !mobile && (live || preview.length > 0), v.startedAt);
  // Ключ не зависит от подключения: те, кто уже был на плитках, при входе в канал не появляются заново
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
                ? 'Подключаемся…'
                : v.error ?? (other ? `Вы в голосовом канале «${other}»` : `${preview.length} ${plural(preview.length, 'участник', 'участника', 'участников')} в Лобби`)}
            </span>
            {!connecting && (
              <button className="btn btn-primary" onClick={app.joinVoice}>
                <Icon name="voice" size={18} />
                {v.error ? 'Повторить' : other ? 'Перейти сюда' : 'Подключиться'}
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
        <h3>Лобби</h3>
        {here && v.state === 'connecting' ? (
          <p>Подключаемся к голосовому каналу…</p>
        ) : (
          <>
            <p>{v.error ?? (other ? `Вы в голосовом канале сервера «${other}».` : 'Вы не в голосовом канале.')}</p>
            <button className="btn btn-primary" onClick={app.joinVoice} style={{ height: 44, padding: '0 24px' }}>
              <Icon name="voice" size={18} />
              {v.error ? 'Повторить' : other ? 'Перейти сюда' : 'Подключиться'}
            </button>
          </>
        )}
      </div>
    );
  }
  const avatar = size ? Math.round(Math.min(160, Math.max(56, size.w * 0.38))) : 80;
  const tiles: ReactNode[] = [
    ...peerTiles.map((t) => <Tile key={t.key} p={t.item} anim={t.anim} kind="cam" avatar={mobile ? 80 : avatar} />),
    ...screenTiles.map((t) => <Tile key={t.key + ':screen'} p={t.item} anim={t.anim} kind="screen" wide={mobile} />),
  ];
  return (
    <>
      <div
        className="tiles"
        data-n={mobile ? Math.min(count, 7) : undefined}
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

export function MockNote({ children }: { children: ReactNode }) {
  return <span className="soon">{children}</span>;
}
