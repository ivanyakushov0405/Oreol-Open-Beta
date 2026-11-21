import { openProfile, EDIT_PROFILE_EVENT } from './profile';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AppState } from './App';
import { Icon, StrikeIcon, type IconName } from './icons';
import { useMicLevel } from './micLevel';
import { handleOf, type Channel, type ServerId } from './mock';
import { STATUS_LABEL } from './Desktop';
import { SERVER_NAV, ServerSettingsBody, isServerSection, isUserSection, USER_NAV, UserSettingsBody, userSectionTitle, type ServerSection, type UserSection } from './Settings';
import { Avatar, Banner, BannerTop, MemberCard, MemberRow, TypingLine } from './ui';
import { parseRoute, paths, useUrlSync } from './router';
import { ChannelList, ChatBody, PinnedButton, QUALITY_TITLE, Rail, STATUS_ITEMS, SignalIcon, VoiceStage, pingClass, useElapsed, UnreadBadge, chatUnread } from './views';

type Tab = 'servers' | 'chats' | 'you';

/** Длительность выезда экрана (чат, войс, участники, настройки) — совпадает с анимацией в CSS. */
const SLIDE_MS = 220;
/** Выезд экрана справа налево — медленнее, чем уезд обратно. */
const SLIDE_IN_MS = 340;

const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: 'servers', label: 'Серверы', icon: 'servers' },
  { id: 'chats', label: 'Чаты', icon: 'oreol' },
  { id: 'you', label: 'Вы', icon: 'users' },
];

/** Функции текстового канала в меню «Ещё» (как кнопки в шапке канала на десктопе). */
const CHAT_MENU: { icon: IconName; label: string; soon?: string }[] = [
  { icon: 'pin', label: 'Закреплённые' },
  { icon: 'bell', label: 'Уведомления', soon: 'Настройка уведомлений появится позже' },
  { icon: 'copy', label: 'Копировать название' },
];

function Head({
  title,
  sub,
  onBack,
  avatar,
  icon,
  actions,
  actionsHidden,
  swapKey,
  fromTitle,
}: {
  title: string;
  sub?: React.ReactNode;
  onBack: () => void;
  avatar?: React.ReactNode;
  /** Иконка канала слева в заголовке (Figma: «Chat header» → Title → Icon). */
  icon?: IconName;
  /** Кнопки справа (Figma: группа «Actions» в шапке). */
  actions?: React.ReactNode;
  /** Кнопки справа плавно спрятаны (например, кнопка чата, когда чат уже открыт). */
  actionsHidden?: boolean;
  /** Смена «экрана» внутри шапки (войс ↔ чат Лобби): кнопки подпрыгивают, название растворяется и проявляется новое. */
  swapKey?: string;
  /** Название экрана, с которого пришли (настройки → раздел): при открытии оно растворяется в новое. */
  fromTitle?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const last = useRef({ key: swapKey, title, icon });
  // Уходящее название и иконка (подпись — время, пинг — не трогаем: она общая и живая)
  const [ghost, setGhost] = useState<{ title: string; icon?: IconName } | null>(fromTitle ? { title: fromTitle } : null);
  /** Счётчик «подпрыгиваний»: при открытии экрана и при каждой смене swapKey. */
  const [bump, setBump] = useState(1);
  /** Экран открыт из списка (до него шапки не было): кнопки «вырастают из ничего». */
  const [pop, setPop] = useState(!fromTitle);
  useEffect(() => {
    if (!pop) return;
    const id = window.setTimeout(() => setPop(false), 480);
    return () => window.clearTimeout(id);
  }, [pop]);
  useLayoutEffect(() => {
    if (last.current.key !== swapKey) {
      setGhost({ title: last.current.title, icon: last.current.icon });
      setBump((b) => b + 1);
    }
    last.current = { key: swapKey, title, icon };
  });
  useEffect(() => {
    if (!ghost) return;
    const id = window.setTimeout(() => setGhost(null), 320);
    return () => window.clearTimeout(id);
  }, [ghost]);
  // Перезапуск анимации без пересоздания элементов: чередуем два одинаковых класса
  const bumpCls = pop || (bump === 1 && !fromTitle) ? '' : bump % 2 ? ' bump-a' : ' bump-b';
  const swapIn = bump > 1 || ghost ? ' sw-in' : '';
  return (
    <div className={'m-head' + (pop ? ' pop' : '')} ref={ref}>
      <button className={'pill-btn glass' + bumpCls} onClick={onBack} title="Назад">
        <Icon name="back" />
      </button>
      <div className={'title-pill glass' + bumpCls}>
        {avatar}
        {(icon || ghost?.icon) && (
          <span className="ico-swap">
            {icon && <Icon key={'i-' + (swapKey ?? '') + icon} name={icon} size={24} className={'title-ico' + swapIn} />}
            {ghost?.icon && <Icon name={ghost.icon} size={24} className="title-ico sw-out" />}
          </span>
        )}
        <div style={{ minWidth: 0 }}>
          <div className="t-wrap">
            <div key={'t-' + (swapKey ?? '') + title} className={'t' + swapIn}>
              {title}
            </div>
            {ghost && (
              <div className="t sw-out" aria-hidden="true">
                {ghost.title}
              </div>
            )}
          </div>
          {sub != null && <div className="s">{sub}</div>}
        </div>
      </div>
      {actions && (
        <div className={'group glass' + (actionsHidden ? ' gone' : bumpCls)} aria-hidden={actionsHidden || undefined}>
          {actions}
        </div>
      )}
    </div>
  );
}

/** Высота полосы под свёрнутой пилюлей (без отступа под строку состояния). */
const PILL_SPACE = 40;

/** Виджет идущего звонка (как плашка звонка на телефоне). Висит над всеми вкладками и экранами;
 *  на экране своего голосового канала уезжает вверх. Тянешь за полоску снизу — сворачивается в пилюлю. */
function MobileCall({
  app,
  gone,
  min,
  onMin,
  onOpen,
  onOpenChat,
  onMore,
  onMeasure,
  liveMic,
}: {
  app: AppState;
  /** Открыт экран этого же войса — виджет не нужен, уезжает вверх. */
  gone: boolean;
  /** Свёрнут в пилюлю сверху. */
  min: boolean;
  onMin: () => void;
  onOpen: () => void;
  onOpenChat: () => void;
  onMore: (btn: HTMLElement) => void;
  /** Высота виджета и смещение пальца — по ним сдвигаются шапки и содержимое экранов. */
  onMeasure: (h: number | null, drag: number | null) => void;
  /** Подсвечивать микрофон, пока говоришь (на панели серверов и каналов это видно в списке войса). */
  liveMic: boolean;
}) {
  const v = app.voice;
  const micBtn = useRef<HTMLButtonElement>(null);
  useMicLevel(micBtn, liveMic && v.micOn && v.state === 'connected', v.micTrack);
  const elapsed = useElapsed(v.startedAt);
  const box = useRef<HTMLDivElement>(null);
  const [h, setH] = useState<number | null>(null);
  /** Смещение пальца при перетаскивании полоски (только вверх, ≤ 0). */
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
    // Короткое нажатие или рывок вверх на пятую часть высоты — сворачиваем
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
            <span className={'m-call-signal ' + q} title={v.rtt != null ? `Пинг ${v.rtt} мс` : undefined}>
              <SignalIcon size={24} />
            </span>
            <button className="m-call-text" onClick={onOpenChat} title="Открыть чат голосового канала" tabIndex={shut ? -1 : undefined}>
              <span className="t">
                <b className={'st ' + q}>{connecting ? 'Подключение…' : QUALITY_TITLE[v.quality]}</b>
                {!connecting && <span className={'ping ' + pingClass(v.rtt, v.quality)}>{v.rtt != null ? `${v.rtt} мс` : '… мс'}</span>}
                <span className="where">
                  <span className="ch">{ch?.name ?? 'Голосовой'}</span>
                  {srv?.name && <span className="sv">{srv.name}</span>}
                </span>
              </span>
              <span className="s">
                {v.peers.length} в канале
                {elapsed && ` · ${elapsed}`}
              </span>
            </button>
            <button className="m-call-back" title="Вернуться в голосовой канал" aria-label="Вернуться в голосовой канал" onClick={onOpen}>
              <Icon name="expand" size={20} />
            </button>
          </div>
          {/* Все кнопки в одном стиле и на равном расстоянии; микрофон и наушники — посередине */}
          <div className="m-call-ctrls">
            <button className={'m-call-btn' + (v.cameraOn ? ' on' : '')} title={v.cameraOn ? 'Выключить камеру' : 'Включить камеру'} onClick={v.toggleCamera}>
              <Icon name={v.cameraOn ? 'video' : 'video-off'} size={22} />
            </button>
            <button
              ref={micBtn}
              className={'m-call-btn mic-lvl' + (v.micOn ? '' : ' off')}
              title={v.micOn ? 'Выключить микрофон' : 'Включить микрофон'}
              onClick={() => void v.toggleMic()}
            >
              <StrikeIcon name="mic" off={!v.micOn} size={22} />
              {liveMic && v.micOn && <Icon name="mic" size={22} className="mic-fill" />}
            </button>
            <button className={'m-call-btn' + (v.deafened ? ' off' : '')} title={v.deafened ? 'Включить звук' : 'Выключить звук'} onClick={v.toggleDeafen}>
              <StrikeIcon name="headphones" off={v.deafened} size={22} />
            </button>
            <button className="m-call-btn" title="Ещё" aria-label="Ещё" onClick={(e) => onMore(e.currentTarget)}>
              <Icon name="more" size={22} />
            </button>
            <button className="ctrl leave m-call-leave" title="Отключиться" aria-label="Отключиться" onClick={v.leave}>
              <Icon name="phone-off" size={22} />
            </button>
          </div>
          <div
            className="m-call-grab"
            role="button"
            tabIndex={0}
            aria-label="Свернуть виджет"
            title="Потяните вверх, чтобы свернуть"
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

/** Свёрнутый виджет: «Wi‑Fi Канал / Сервер» в бирюзовой пилюле поверх всего (под строкой состояния телефона). */
function MobileCallPill({ app, shown, onExpand }: { app: AppState; shown: boolean; onExpand: () => void }) {
  const v = app.voice;
  if (v.state === 'idle') return null;
  const srv = app.serverById(v.server);
  const ch = srv?.channels.find((c) => c.kind === 'voice');
  const q = v.state === 'connecting' ? 'q-medium' : `q-${v.quality}`;
  return (
    <button className={'m-call-pill' + (shown ? '' : ' gone')} onClick={onExpand} title="Развернуть виджет звонка" tabIndex={shown ? undefined : -1} aria-hidden={shown ? undefined : true}>
      <span className={'sig ' + q}>
        <SignalIcon size={16} />
      </span>
      <span className="txt">
        <span className="ch">{ch?.name ?? 'Голосовой'}</span>
        {srv?.name && <span className="sv">{srv.name}</span>}
      </span>
    </button>
  );
}

/** true через SLIDE_IN_MS после того, как flag стал true (экран полностью выехал); сразу false, когда flag снят. */
function useSettled(flag: boolean) {
  const [settled, setSettled] = useState(flag);
  useEffect(() => {
    if (!flag) {
      setSettled(false);
      return;
    }
    const id = window.setTimeout(() => setSettled(true), SLIDE_IN_MS);
    return () => window.clearTimeout(id);
  }, [flag]);
  return settled;
}

/** Затемнение под таб-панелью (::after у .m-stage) — с дыркой под самой панелью: стекло панели им не темнеет. */
function useTabShadeClip(stage: React.RefObject<HTMLDivElement>) {
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const update = () => {
      const tb = el.querySelector<HTMLElement>(':scope > .tabbar');
      const after = getComputedStyle(el, '::after');
      const H = parseFloat(after.height) || 0;
      if (!tb || !H || after.content === 'none') return el.style.removeProperty('--tab-clip');
      const s = el.getBoundingClientRect();
      const r = tb.getBoundingClientRect();
      const W = s.width;
      const x = r.left - s.left;
      const y = r.top - (s.bottom - H);
      const w = r.width;
      const h = r.height;
      const rad = Math.min(parseFloat(getComputedStyle(tb).borderTopLeftRadius) || 0, w / 2, h / 2);
      const d =
        `M0 0H${W}V${H}H0Z` +
        `M${x + rad} ${y}H${x + w - rad}A${rad} ${rad} 0 0 1 ${x + w} ${y + rad}V${y + h - rad}A${rad} ${rad} 0 0 1 ${x + w - rad} ${y + h}` +
        `H${x + rad}A${rad} ${rad} 0 0 1 ${x} ${y + h - rad}V${y + rad}A${rad} ${rad} 0 0 1 ${x + rad} ${y}Z`;
      el.style.setProperty('--tab-clip', `path(evenodd, '${d}')`);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    const watch = () => {
      const tb = el.querySelector(':scope > .tabbar');
      if (tb) ro.observe(tb);
      update();
    };
    const mo = new MutationObserver(watch);
    mo.observe(el, { childList: true });
    watch();
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}

export function Mobile({ app }: { app: AppState }) {
  const stageRef = useRef<HTMLDivElement>(null);
  useTabShadeClip(stageRef);
  const [tab, setTab] = useState<Tab>('servers');
  // «Прыжок» иконки — только при нажатии на вкладку, а не когда таб-панель появляется снова (выход из войса/чата)
  const [hop, setHop] = useState<Tab | null>(null);
  const hopTimer = useRef(0);
  const pickTab = (t: Tab) => {
    if (t !== tab) {
      setHop(t);
      window.clearTimeout(hopTimer.current);
      hopTimer.current = window.setTimeout(() => setHop(null), 450);
    }
    setTab(t);
  };
  const [open, setOpen] = useState<Channel | null>(null);
  const [voiceChat, setVoiceChat] = useState(false);
  const [settings, setSettings] = useState<UserSection | null>(null);
  // «Редактировать профиль» из окна полного профиля
  useEffect(() => {
    const edit = () => setSettings('account-edit');
    window.addEventListener(EDIT_PROFILE_EVENT, edit);
    return () => window.removeEventListener(EDIT_PROFILE_EVENT, edit);
  }, []);
  const [members, setMembers] = useState(false);
  /** Меню «Ещё» в шапке текстового канала. */
  const [chatMenu, setChatMenu] = useState(false);
  const [settingsHome, setSettingsHome] = useState(false);
  /** Настройки сервера: список разделов и открытый раздел. */
  const [serverHome, setServerHome] = useState(false);
  const [serverSection, setServerSection] = useState<ServerSection | null>(null);
  const [card, setCard] = useState<string | null>(null);
  const online = app.membersOnline;
  const elapsed = useElapsed(app.voice.startedAt);
  /** Какой экран сейчас уезжает вправо (по «Назад»). */
  const [leaving, setLeaving] = useState<string | null>(null);
  const leaveTimer = useRef<number | undefined>(undefined);
  const close = (key: string, done: () => void) => {
    if (leaving) return;
    quiet.current.delete(key);
    setLeaving(key);
    leaveTimer.current = window.setTimeout(() => {
      done();
      setLeaving(null);
    }, SLIDE_MS);
  };
  useEffect(() => () => window.clearTimeout(leaveTimer.current), []);
  // Нижний экран прячем только когда верхний полностью выехал — иначе под ним во время анимации пусто
  // Экраны настроек тоже «верхние»: у них прозрачный фон (виден тор), поэтому нижний экран под ними гаснет
  const settingsOpen = [settingsHome, serverHome, !!settings, !!serverSection].filter(Boolean).length;
  const top = !!open || members || settingsOpen > 0;
  const settled = useSettled(top);
  // уезжает сам верхний экран (а не вложенный, например чат Лобби внутри войса или раздел настроек)
  const leavingTop =
    leaving === 'chat' ||
    leaving === 'voice' ||
    leaving === 'members' ||
    (settingsOpen === 1 && (leaving === 'home' || leaving === 'shome' || leaving === 'ssec' || leaving === 'settings'));
  const covered = top && settled && !leavingTop;
  /** Экраны, открытые из адреса при загрузке страницы: стоят на месте, а не выезжают (класс держится, пока экран открыт). */
  const quiet = useRef(new Set<string>());
  const firstApply = useRef(true);
  const slide = (key: string) => (leaving === key ? ' m-slide out' : ' m-slide' + (quiet.current.has(key) ? ' m-quiet' : ''));
  /** Нижний экран: пока верхний выезжает — плавно гаснет, пока уезжает — плавно проявляется
   *  (иначе сквозь прозрачный фон видно, как он резко пропадает). */
  const under = (hidden: boolean, back: boolean) => ' m-under' + (hidden ? ' dim' : '') + (back ? ' back' : '');
  const underMain = under(top && !leavingTop, top && leavingTop);
  // Чат Лобби поверх сцены войса: сцену убираем только когда чат полностью выехал
  const vchatSettled = useSettled(voiceChat);
  const showStage = !voiceChat || !vchatSettled || leaving === 'vchat';
  /** Шапка переключается сразу по нажатию (и при открытии, и при «Назад»), не дожидаясь конца выезда. */
  const vchatShown = voiceChat && leaving !== 'vchat';

  // Голосовой канал текущего сервера (у сервера, где мы в голосе, — свой)
  const voiceCh = (app.serverById(app.voice.server) ?? app.server).channels.find((c) => c.kind === 'voice') ?? app.voiceChannel;
  const voiceName = voiceCh?.name ?? 'Голосовой';
  const cardMember = card ? app.members.find((m) => m.username === card) : undefined;

  /** Виджет звонка свёрнут в пилюлю. */
  const [callMin, setCallMin] = useState(false);
  /** Меню «…» виджета: под кнопкой. */
  const [callMenu, setCallMenu] = useState<{ top: number; right: number } | null>(null);
  const inCall = app.voice.state !== 'idle';
  useEffect(() => {
    if (!inCall) {
      setCallMin(false);
      setCallMenu(null);
    }
  }, [inCall]);
  /** Открыт экран войса, в котором мы сейчас, — виджет уезжает вверх. */
  const onOwnVoice = !!open && open.kind === 'voice' && app.inVoiceHere && leaving !== 'voice';
  const [callSize, setCallSize] = useState<{ h: number | null; drag: number | null }>({ h: null, drag: null });
  /** Сколько места сверху занимает виджет: развёрнутый — свою высоту, свёрнутый — полосу под пилюлей
   *  (во «Вы» пилюля лежит прямо на баннере), на экране своего войса — ничего. */
  const pillSpace = tab === 'you' ? 0 : PILL_SPACE;
  /** Во «Вы» сцена под пилюлей не сдвигается (профиль не дёргается, когда закрываются настройки) —
   *  отступ под пилюлю берут только экраны, открытые поверх. */
  const pillOver = inCall && callMin && !onOwnVoice && tab === 'you' && top;
  const callH = callSize.h ?? 0;
  /** Высоту анимируем только когда сам виджет сворачивается/разворачивается/уезжает —
   *  при смене вкладки экраны встают на место сразу, без подстраивания. */
  const [callAnim, setCallAnim] = useState(false);
  const animKey = `${inCall}:${callMin}:${onOwnVoice}`;
  const lastAnimKey = useRef(animKey);
  useLayoutEffect(() => {
    if (lastAnimKey.current === animKey) return;
    lastAnimKey.current = animKey;
    setCallAnim(true);
    const id = window.setTimeout(() => setCallAnim(false), 420);
    return () => window.clearTimeout(id);
  }, [animKey]);
  const callSpace = !inCall || onOwnVoice ? 0 : callSize.drag != null ? Math.max(pillSpace, callH + callSize.drag) : callMin ? pillSpace : callH;
  /** Из виджета — в свой голосовой канал: всё, что открыто поверх, закрываем. */
  /** Куда вернуться, когда закроют чат войса, открытый нажатием на текст виджета: тот же экран, что был под ним. */
  const ret = useRef<null | (() => void)>(null);
  useEffect(() => {
    if (!open || open.kind !== 'voice') ret.current = null;
  }, [open]);
  const openVoice = (withChat = false) => {
    const onVoice = !!open && open.kind === 'voice';
    if (withChat && !onVoice) {
      const was = { tab, open, members, settingsHome, settings, serverHome, serverSection, sid: app.serverId };
      ret.current = () => {
        app.setServerId(was.sid as ServerId);
        setTab(was.tab);
        setOpen(was.open);
        setVoiceChat(false);
        setMembers(was.members);
        setSettingsHome(was.settingsHome);
        setSettings(was.settings);
        setServerHome(was.serverHome);
        setServerSection(was.serverSection);
      };
    } else if (!withChat) {
      // в сам войс: по выходу из него — список каналов этого сервера
      ret.current = null;
      setTab('servers');
    }
    if (app.voice.server) app.setServerId(app.voice.server as ServerId);
    setSettings(null);
    setSettingsHome(false);
    setServerHome(false);
    setServerSection(null);
    setMembers(false);
    setChatMenu(false);
    setVoiceChat(withChat);
    if (voiceCh) setOpen(voiceCh);
  };

  // Адрес ↔ экраны. Порядок важен: чем выше экран, тем позже он задаёт адрес
  const sid = app.server.id;
  let path = tab === 'chats' ? paths.chats() : tab === 'you' ? paths.you() : paths.server(sid);
  if (members) path = paths.members(sid);
  if (open) path = paths.channel(sid, open.id, open.kind === 'voice' && voiceChat);
  if (serverHome) path = paths.serverSettings(sid);
  if (serverSection) path = paths.serverSettings(sid, serverSection);
  if (settingsHome) path = paths.settings();
  if (settings) path = paths.settings(settings);
  /** «Назад»/«Вперёд» браузера или телефона и открытие по ссылке: верхний закрывающийся экран уезжает с анимацией. */
  const applyRoute = (p: string) => {
    const r = parseRoute(p);
    const srv = r.name === 'server' ? app.serverById(r.sid) : undefined;
    if (srv) app.setServerId(srv.id as ServerId);
    const ch = srv && r.name === 'server' ? srv.channels.find((c) => c.id === r.cid) ?? null : null;
    const sub = r.name === 'server' ? r.sub : undefined;
    const sec = r.name === 'server' || r.name === 'settings' ? r.section : undefined;
    const want = {
      tab: (r.name === 'chats' ? 'chats' : r.name === 'you' ? 'you' : r.name === 'settings' ? tab : 'servers') as Tab,
      open: ch,
      voiceChat: !!ch && ch.kind === 'voice' && sub === 'chat',
      members: !!srv && sub === 'members',
      serverHome: !!srv && sub === 'settings' && (!isServerSection(sec) || serverHome),
      serverSection: !!srv && sub === 'settings' && isServerSection(sec) ? sec : null,
      settingsHome: r.name === 'settings' && (!isUserSection(sec) || settingsHome),
      settings: r.name === 'settings' && isUserSection(sec) ? sec : null,
    };
    if (firstApply.current) {
      firstApply.current = false;
      if (want.open) quiet.current.add(want.open.kind === 'voice' ? 'voice' : 'chat');
      if (want.voiceChat) quiet.current.add('vchat');
      if (want.members) quiet.current.add('members');
      if (want.serverHome) quiet.current.add('shome');
      if (want.serverSection) quiet.current.add('ssec');
      if (want.settingsHome) quiet.current.add('home');
      if (want.settings) quiet.current.add('settings');
    }
    const apply = () => {
      setTab(want.tab);
      setOpen(want.open);
      setVoiceChat(want.voiceChat);
      setMembers(want.members);
      setServerHome(want.serverHome);
      setServerSection(want.serverSection);
      setSettingsHome(want.settingsHome);
      setSettings(want.settings);
      setChatMenu(false);
    };
    let key: string | null = null;
    if (settings && !want.settings) key = 'settings';
    else if (serverSection && !want.serverSection) key = 'ssec';
    else if (settingsHome && !want.settingsHome) key = 'home';
    else if (serverHome && !want.serverHome) key = 'shome';
    else if (members && !want.members) key = 'members';
    else if (open && want.open?.id === open.id && voiceChat && !want.voiceChat) key = 'vchat';
    else if (open && want.open?.id !== open.id) key = open.kind === 'voice' ? 'voice' : 'chat';
    if (key && !leaving) close(key, apply);
    else apply();
  };
  useUrlSync(path, applyRoute, leaving != null);
  // Экран закрыли любым путём — в следующий раз он снова выезжает
  const quietReady = useRef(false);
  useEffect(() => {
    // Первый проход идёт в том же коммите, что и разбор адреса, — состояние ещё пустое, его пропускаем
    if (!quietReady.current) {
      quietReady.current = true;
      return;
    }
    const q = quiet.current;
    if (!open) (q.delete('chat'), q.delete('voice'));
    if (!voiceChat) q.delete('vchat');
    if (!members) q.delete('members');
    if (!serverHome) q.delete('shome');
    if (!serverSection) q.delete('ssec');
    if (!settingsHome) q.delete('home');
    if (!settings) q.delete('settings');
  }, [open, voiceChat, members, serverHome, serverSection, settingsHome, settings]);

  return (
    <div
      className={'m-app' + (app.glassChat ? ' glass-chat' : '') + (app.glassVoice ? ' glass-voice' : '') + (pillOver ? ' pill-over' : '') + (callSize.drag != null ? ' call-drag' : callAnim || lastAnimKey.current !== animKey ? ' call-anim' : '')}
      style={{ '--call-h': `${callSpace}px` } as React.CSSProperties}
    >
      {/* Виджет звонка — над всеми вкладками и экранами (как плашка идущего звонка на телефоне) */}
      <MobileCall
        app={app}
        gone={onOwnVoice}
        min={callMin}
        onMin={() => setCallMin(true)}
        onOpen={() => openVoice()}
        onOpenChat={() => openVoice(true)}
        onMeasure={(h, drag) => setCallSize((s) => (s.h === h && s.drag === drag ? s : { h, drag }))}
        // подсветка микрофона в виджете — везде, кроме списка каналов того сервера, где сидим (там светится сам список)
        liveMic={covered || tab !== 'servers' || app.serverId !== app.voice.server}
        onMore={(btn) => {
          const r = btn.getBoundingClientRect();
          setCallMenu((m) => (m ? null : { top: r.bottom + 8, right: Math.max(12, window.innerWidth - r.right) }));
        }}
      />
      <MobileCallPill app={app} shown={inCall && callMin && !onOwnVoice} onExpand={() => setCallMin(false)} />
      {callMenu && (
        <>
          <div className="popover-backdrop m-menu-backdrop" onClick={() => setCallMenu(null)} />
          <div className="m-menu glass m-call-menu" role="menu" style={{ top: callMenu.top, right: callMenu.right }}>
            <button role="menuitem" className={'m-menu-item' + (app.voice.screenOn ? ' share-on' : '')} onClick={() => { setCallMenu(null); void app.voice.toggleScreen(); }}>
              <Icon name={app.voice.screenOn ? 'screen-share-stop' : 'screen-share'} />
              <span>{app.voice.screenOn ? 'Остановить демонстрацию' : 'Демонстрация экрана'}</span>
            </button>
            <button role="menuitem" className="m-menu-item" onClick={() => { setCallMenu(null); openVoice(true); }}>
              <Icon name="chats" />
              <span>Чат канала</span>
            </button>
            <button role="menuitem" className="m-menu-item" onClick={() => { setCallMenu(null); setSettings('voice'); }}>
              <Icon name="settings" />
              <span>Голос и звук</span>
            </button>
          </div>
        </>
      )}
      <div className="m-stage" ref={stageRef}>
      {!covered && tab === 'servers' && (
        <div className={'m-servers' + underMain}>
          <div className="m-servers-row">
          <Rail app={app} home={false} noHome onHome={() => setTab('chats')} onServer={(id: ServerId) => app.setServerId(id)} />
          <aside className="sidebar glass">
            <div className="sidebar-head">
              <button className="grow srv-name" title="Настройки сервера" onClick={() => setServerHome(true)}>
                <span>{app.server.name}</span>
                <Icon name="chevron-down" size={18} />
              </button>
              <button className="icon-btn" title="Участники" aria-label="Участники" onClick={() => setMembers(true)}>
                <Icon name="users" />
              </button>
            </div>
            <div className="sidebar-scroll">
              <ChannelList
                app={app}
                active={null}
                onOpen={(c) => {
                  setOpen(c);
                  if (c.kind === 'voice') app.joinVoice();
                }}
              />
            </div>
          </aside>
          </div>
        </div>
      )}

      {!covered && tab === 'chats' && (
        <div className={'m-section' + underMain}>
          <h2>Чаты</h2>
          <div className="empty-state" style={{ marginTop: 32, fontSize: 13 }}>
            <b>Личных сообщений пока нет</b>
            Здесь будут ваши диалоги и групповые чаты. Чаты серверов — во вкладке «Серверы».
          </div>
        </div>
      )}

      {!covered && tab === 'you' && (
        <div className={'m-you' + underMain}>
          <BannerTop name={app.name} />
          <Banner name={app.name} />
          <Avatar name={app.name} size={96} status={app.status} />
          <div className="name">{app.me.displayName}</div>
          <div className="handle">{handleOf(app.name)}</div>
          <div className="m-list glass">
            <div className="overline">Статус</div>
            {STATUS_ITEMS.map((st) => (
              <button
                key={st.id}
                role="radio"
                aria-checked={app.status === st.id}
                className={'m-item' + (app.status === st.id ? ' on' : '')}
                onClick={() => app.setStatus(st.id)}
              >
                <i className={`m-dot status-${st.id}`} />
                <span className="grow">{st.label}</span>
                {app.status === st.id && <Icon name="check" size={18} />}
              </button>
            ))}
          </div>
          {/* Профиль (Figma «Mobile · You»): статус, друзья, профиль; настройки — отдельным экраном */}
          <div className="m-list glass">
            <button className="m-item" onClick={() => app.notify('Друзья появятся с полноценным бэкендом')}>
              <Icon name="users" />
              <span className="grow">Друзья</span>
              <Icon name="chevron-right" size={18} />
            </button>
            <button className="m-item" onClick={() => app.notify('Запросы в друзья появятся с полноценным бэкендом')}>
              <Icon name="plus" />
              <span className="grow">Запросы в друзья</span>
              <Icon name="chevron-right" size={18} />
            </button>
            <button className="m-item" onClick={() => setSettings('account-edit')}>
              <Icon name="pencil" />
              <span className="grow">Редактировать профиль</span>
              <Icon name="chevron-right" size={18} />
            </button>
            <button className="m-item" onClick={() => setSettings('appearance')}>
              <Icon name="appearance" />
              <span className="grow">Внешний вид</span>
              <Icon name="chevron-right" size={18} />
            </button>
            <button className="m-item" onClick={() => setSettingsHome(true)}>
              <Icon name="settings" />
              <span className="grow">Настройки</span>
              <Icon name="chevron-right" size={18} />
            </button>
          </div>
          <div className="m-list glass">
            <button className="m-item danger" onClick={app.logout}>
              <Icon name="logout" />
              <span className="grow">Выйти</span>
            </button>
          </div>
        </div>
      )}

      {!covered && (
      <nav className={'tabbar glass' + underMain}>
        {/* Подсветка активной вкладки — одна на всю панель, плавно переезжает к выбранной */}
        <span className="tab-glider" style={{ transform: `translateX(${TABS.findIndex((t) => t.id === tab) * 100}%)` }} aria-hidden="true" />
        {TABS.map((t) => (
          <button key={t.id} className={'tab' + (tab === t.id ? ' on' : '') + (hop === t.id ? ' hop' : '')} onClick={() => pickTab(t.id)}>
            <span className="tab-ico">
              {t.id === 'you' ? (
                <Avatar name={app.name} size={27} />
              ) : (
                <Icon name={t.icon} size={28} className={t.icon === 'oreol' ? 'ico-oreol' : undefined} />
              )}
            </span>
            {t.label}
          </button>
        ))}
      </nav>
      )}

      {open && open.kind === 'text' && (
        <div className={'m-full m-full-chat' + slide('chat')}>
          <Head
            title={open.name}
            icon="chats"
            onBack={() => close('chat', () => setOpen(null))}
            actions={
              <>
                <button className="icon-btn" title="Поиск" aria-label="Поиск" onClick={() => app.notify('Поиск по каналу появится позже')}>
                  <Icon name="search" />
                </button>
                <button className={'icon-btn' + (chatMenu ? ' active' : '')} title="Ещё" aria-label="Ещё" aria-expanded={chatMenu} onClick={() => setChatMenu((v) => !v)}>
                  <Icon name="more" />
                </button>
              </>
            }
            sub={<TypingLine users={app.general.typingUsers.filter((u) => u !== app.name)} fallback={app.membersReady ? `${online.length} в сети` : ' '} />}
          />
          <ChatBody app={app} chat={app.general} channel={open} compact />
          {chatMenu && (
            <>
              <div className="popover-backdrop m-menu-backdrop" onClick={() => setChatMenu(false)} />
              <div className="m-menu glass" role="menu">
                {CHAT_MENU.map((it) => (
                  <button
                    key={it.label}
                    role="menuitem"
                    className="m-menu-item"
                    onClick={() => {
                      setChatMenu(false);
                      if (it.label === 'Закреплённые') app.general.setView('pinned');
                      else if (it.label === 'Копировать название') {
                        void navigator.clipboard?.writeText(`#${open.name}`).then(
                          () => app.notify('Название канала скопировано', 'success'),
                          () => app.notify('Не удалось скопировать', 'error'),
                        );
                      } else app.notify(it.soon!);
                    }}
                  >
                    <Icon name={it.icon} />
                    <span>{it.label}</span>
                    {it.label === 'Закреплённые' && app.general.pinned.length > 0 && <span className="m-menu-count">{app.general.pinned.length}</span>}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {open && open.kind === 'voice' && (
        <div className={'m-full m-full-voice' + (vchatShown ? ' with-chat' : '') + slide('voice')}>
          <Head
            swapKey={vchatShown ? 'chat' : 'voice'}
            title={vchatShown ? `Чат · ${open.name}` : open.name}
            icon={vchatShown ? 'chats' : 'voice'}
            onBack={() => {
              const back = ret.current;
              if (voiceChat && back) close('voice', back);
              else if (voiceChat) close('vchat', () => setVoiceChat(false));
              else close('voice', () => setOpen(null));
            }}
            sub={
              app.inVoiceHere && app.voice.state === 'connected' ? (
                <>
                  {/* Точка — тот же статус связи, что и значок Wi‑Fi в панели «Подключено» */}
                  {/* Пинг — сразу после «Подключено», обычным текстом */}
                  <i className={`live-dot q-${app.voice.quality}`} />
                  Подключено
                  {app.voice.rtt != null && ` · ${app.voice.rtt} мс`}
                  {` · ${app.voice.peers.length} в канале · ${elapsed}`}
                </>
              ) : app.inVoiceHere && app.voice.state === 'connecting' ? (
                <>
                  <i className="live-dot q-medium" />
                  Подключение…
                </>
              ) : (
                'Голосовой канал'
              )
            }
            actions={
              vchatShown ? (
                <PinnedButton chat={app.lobby} />
              ) : (
                <button className="icon-btn has-badge" title="Чат канала" aria-label="Чат канала" onClick={(e) => { e.currentTarget.blur(); setVoiceChat(true); }}>
                  <Icon name="chats" />
                  <UnreadBadge n={chatUnread(app, app.lobby)} className="corner" />
                </button>
              )
            }
          />
          {/* Сцена не пересоздаётся под чатом: иначе аватарки мигают/резко пропадают за стеклом */}
          <div className={'m-voice' + (showStage ? '' : ' covered')} aria-hidden={showStage ? undefined : true}>
            <VoiceStage app={app} mobile />
          </div>
          {voiceChat && (
            <div className={'m-voice-chat' + slide('vchat')}>
              <ChatBody app={app} chat={app.lobby} channel={open} compact />
            </div>
          )}
        </div>
      )}

      {members && (
        <div className={'m-full m-members' + slide('members')}>
          <Head title="Участники" sub={app.membersReady ? `${app.server.name} · ${online.length} в сети` : app.server.name} onBack={() => close('members', () => setMembers(false))} />
          <div className="m-members-list glass">
            <div className="section-title overline">В сети — {online.length}</div>
            {online.map((m) => (
              <MemberRow
                key={m.username}
                name={m.username}
                me={m.username === app.name}
                status={m.status}
                sub={app.voiceUsers.some((v) => v.identity === m.username) ? `В голосовом · ${voiceName}` : handleOf(m.username)}
                onClick={() => setCard(m.username)}
              />
            ))}
            {app.membersOffline.length > 0 && <div className="section-title overline">Не в сети — {app.membersOffline.length}</div>}
            {app.membersOffline.map((m) => (
              <MemberRow
                key={m.username}
                name={m.username}
                me={m.username === app.name}
                status="offline"
                sub={handleOf(m.username)}
                onClick={() => setCard(m.username)}
              />
            ))}
          </div>
        </div>
      )}

      {card && (
        <MemberCard
          sheet
          serverIcon={{ short: app.server.short, gradient: app.server.gradient }}
          onCall={() => app.notify('Личные звонки появятся с полноценным бэкендом')}
          name={card}
          me={card === app.name}
          at={{ x: 0, y: 0 }}
          status={app.statusOf(card)}
          activity={app.voiceUsers.some((v) => v.identity === card) ? `В голосовом · ${voiceName}` : STATUS_LABEL[app.statusOf(card)]}
          serverName={app.server.name}
          since={cardMember?.joinedAt ? new Date(cardMember.joinedAt) : new Date()}
          onClose={() => setCard(null)}
          onProfile={() => {
            const mine = card === app.name;
            setCard(null);
            if (mine) setSettings('account-edit');
            else openProfile(card);
          }}
        />
      )}

      {settingsHome && (
        <div className={'m-settings' + slide('home')}>
          <Head title="Настройки" onBack={() => close('home', () => setSettingsHome(false))} />
          <div className="m-settings-home">
            <div className="m-list glass m-account-row">
              <Avatar name={app.name} size={56} status={app.status} />
              <span className="info">
                <b>{app.name}</b>
                <span>{handleOf(app.name)}</span>
              </span>
            </div>
            <div className="overline m-group-title">Настройки пользователя</div>
            <div className="m-list glass">
              {USER_NAV.slice(0, 4).map((n) => (
                <button key={n.id} className="m-item" onClick={() => setSettings(n.id)}>
                  <Icon name={n.icon} />
                  <span className="grow">{n.label}</span>
                  <Icon name="chevron-right" size={18} />
                </button>
              ))}
            </div>
            <div className="overline m-group-title">Приложение</div>
            <div className="m-list glass">
              {USER_NAV.slice(4).map((n) => (
                <button key={n.id} className="m-item" onClick={() => setSettings(n.id)}>
                  <Icon name={n.icon} />
                  <span className="grow">{n.label}</span>
                  <Icon name="chevron-right" size={18} />
                </button>
              ))}
            </div>
            <div className="m-list glass">
              <button className="m-item danger" onClick={app.logout}>
                <Icon name="logout" />
                <span className="grow">Выйти</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {serverHome && (
        <div className={'m-settings' + slide('shome')}>
          <Head title="Настройки сервера" onBack={() => close('shome', () => setServerHome(false))} />
          <div className="m-settings-home">
            <div className="m-list glass">
              {SERVER_NAV.filter((n) => !n.group && n.id !== 'moderation').map((n) => (
                <button key={n.id} className="m-item" onClick={() => setServerSection(n.id)}>
                  <Icon name={n.icon} />
                  <span className="grow">{n.label}</span>
                  <Icon name="chevron-right" size={18} />
                </button>
              ))}
            </div>
            <div className="overline m-group-title">Модерация</div>
            <div className="m-list glass">
              {SERVER_NAV.filter((n) => n.group || n.id === 'moderation').map((n) => (
                <button key={n.id} className="m-item" onClick={() => setServerSection(n.id)}>
                  <Icon name={n.icon} />
                  <span className="grow">{n.label}</span>
                  <Icon name="chevron-right" size={18} />
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {serverSection && (
        <div className={'m-settings' + slide('ssec')}>
          <Head title={SERVER_NAV.find((n) => n.id === serverSection)?.label ?? 'Сервер'} fromTitle="Настройки сервера" onBack={() => close('ssec', () => setServerSection(null))} />
          <div className="settings-body" style={{ overflowY: 'auto' }}>
            <ServerSettingsBody app={app} section={serverSection} />
          </div>
        </div>
      )}

      {settings && (
        <div className={'m-settings' + slide('settings')}>
          <Head title={userSectionTitle(settings)} fromTitle={settingsHome ? 'Настройки' : undefined} onBack={() => close('settings', () => setSettings(null))} />
          <div className="settings-body" style={{ overflowY: 'auto' }}>
            <UserSettingsBody app={app} section={settings} onSection={setSettings} />
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
