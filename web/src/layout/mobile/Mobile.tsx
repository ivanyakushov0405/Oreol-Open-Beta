import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { markForward, markReturn, parseRoute, paths, useUrlSync } from '../../app/router';
import type { AppState } from '../../app/useAppState';
import { STATUS_ITEMS } from '../../features/account/AccountMenu';
import { STATUS_LABEL } from '../../features/account/status';
import { ChatBody, PinnedButton } from '../../features/chat/ChatBody';
import { TypingLine } from '../../features/chat/TypingLine';
import { MENTION_EVENT } from '../../features/chat/mentions';
import { chatUnread, UnreadBadge } from '../../features/chat/unread';
import { MemberCard } from '../../features/members/MemberCard';
import { MemberRow } from '../../features/members/MemberRow';
import { EDIT_PROFILE_EVENT, openProfile, ProfileDetails, setProfileOpener } from '../../features/profile/profile';
import { ChannelList } from '../../features/servers/ChannelList';
import { Rail } from '../../features/servers/Rail';
import { ServerSettingsBody } from '../../features/settings/ServerSettings';
import { pressIcon } from '../../features/settings/SettingsScreen';
import { UserSettingsBody } from '../../features/settings/UserSettings';
import { isServerSection, isUserSection, SERVER_NAV, USER_NAV, userSectionTitle, type ServerSection, type UserSection } from '../../features/settings/nav';
import { VoiceStage } from '../../features/voice/VoiceStage';
import { Elapsed } from '../../features/voice/VoiceStatus';
import { ChatsIcon, Icon, SlidersIcon, type IconName } from '../../shared/icons';
import { handleOf, type Channel, type ServerId } from '../../shared/model';
import { Avatar, Banner, BannerTop } from '../../shared/ui/Avatar';
import { MobileCall, MobileCallPill, PILL_SPACE } from './MobileCall';
import { Head } from './MobileHead';
import { useStageSwipes } from './swipes';
import { useJellyTabs, useSettled, useTabShadeClip } from './tabs';

type Tab = 'servers' | 'chats' | 'you';

/** Длительность выезда экрана (чат, войс, участники, настройки) — совпадает с анимацией в CSS. */
const SLIDE_MS = 220;
/** Выезд экрана справа налево — медленнее, чем уезд обратно. */
export const SLIDE_IN_MS = 340;

const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: 'servers', label: 'Серверы', icon: 'servers' },
  { id: 'chats', label: 'Чаты', icon: 'oreol' },
  { id: 'you', label: 'Вы', icon: 'users' },
];

/** Функции текстового канала в меню «Ещё» (как кнопки в шапке канала на десктопе). */
const CHAT_MENU: { icon: IconName; label: string; soon?: string }[] = [
  { icon: 'pin', label: 'Закреплённые' },
  { icon: 'bell', label: 'Уведомления', soon: 'Настройка уведомлений — скоро будет' },
  { icon: 'copy', label: 'Копировать название' },
];

/** Пока hold — содержимое не перерисовывается (React берёт прошлый результат).
 *  Экраны под войсом другого сервера, открытым из виджета, так и показывают свой сервер, хотя приложение уже на сервере войса. */
const Hold = memo(
  function Hold({ children }: { hold: boolean; children: ReactNode }) {
    return <>{children}</>;
  },
  (_prev, next) => next.hold,
);

export function Mobile({ app }: { app: AppState }) {
  const stageRef = useRef<HTMLDivElement>(null);
  useTabShadeClip(stageRef);
  const [tab, setTab] = useState<Tab>('servers');
  // Во время свайпа назад нижний экран снова рисуем — он проявляется под уезжающим верхним
  const [peek, setPeek] = useState(false);
  // «Прыжок» иконки — только при нажатии на вкладку, а не когда таб-панель появляется снова (выход из войса/чата)
  const [hop, setHop] = useState<Tab | null>(null);
  const hopTimer = useRef(0);
  const tabInTimer = useRef(0);
  const pickTab = (t: Tab) => {
    if (t !== tab) {
      // новая вкладка мягко проявляется из размытия (без въезда сбоку)
      const st = stageRef.current;
      if (st) {
        st.dataset.tabIn = '';
        window.clearTimeout(tabInTimer.current);
        tabInTimer.current = window.setTimeout(() => delete st.dataset.tabIn, 360);
      }
      setHop(t);
      window.clearTimeout(hopTimer.current);
      hopTimer.current = window.setTimeout(() => setHop(null), 450);
    }
    setTab(t);
  };
  const navRef = useRef<HTMLElement>(null);
  const gliderRef = useRef<HTMLSpanElement>(null);
  useJellyTabs(navRef, gliderRef, TABS.findIndex((t) => t.id === tab), TABS.length, (i) => pickTab(TABS[i].id));
  const tabIdx = TABS.findIndex((t) => t.id === tab);
  useStageSwipes(stageRef, {
    onPeek: setPeek,
    canTab: (dir) => !!TABS[tabIdx + dir],
    onTab: (dir) => {
      const next = TABS[tabIdx + dir];
      if (next) pickTab(next.id);
    },
  });
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
  // Смена сервера во вкладке «Серверы»: анимируем название, кнопку участников и каналы (не при первом показе вкладки)
  const lastSrv = useRef(app.server.id);
  /** Когда сменили сервер. Класс анимации держится недолго: иначе он «залипал» и каналы анимировались заново,
   *  каждый раз когда список появлялся снова (после «Назад» из чата, войса, настроек). */
  const srvSwitchAt = useRef(0);
  /** Сервер сменился из-за виджета (открыли войс другого сервера или вернулись из него) — без анимации смены. */
  const srvQuiet = useRef(false);
  if (lastSrv.current !== app.server.id) {
    lastSrv.current = app.server.id;
    if (!srvQuiet.current && tab === 'servers') srvSwitchAt.current = Date.now();
    srvQuiet.current = false;
  }
  const srvSwitch = tab === 'servers' && Date.now() - srvSwitchAt.current < 700;
  // Профиль из чата, упоминаний и т.п. открывается той же шторкой, что и из списка участников
  useEffect(() => {
    setProfileOpener((name) => setCard(name));
    const close = () => setCard(null);
    window.addEventListener(MENTION_EVENT, close);
    return () => {
      setProfileOpener(null);
      window.removeEventListener(MENTION_EVENT, close);
    };
  }, []);
  const online = app.membersOnline;
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
  /** Войс открыт из виджета поверх текущих экранов (чата, участников, настроек): они остаются под ним как есть. */
  const overVoice = useRef(false);
  // уезжает сам верхний экран (а не вложенный, например чат Лобби внутри войса или раздел настроек)
  const leavingTop =
    leaving === 'chat' ||
    (leaving === 'voice' && !overVoice.current) ||
    leaving === 'members' ||
    (settingsOpen === 1 && (leaving === 'home' || leaving === 'shome' || leaving === 'ssec' || leaving === 'settings'));
  const covered = top && settled && !leavingTop && !peek;
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
  /** Куда вернуться, когда закроют войс (или его чат), открытый из виджета: тот же экран, что был под ним. */
  const ret = useRef<null | (() => void)>(null);
  /** Из виджета открыли сразу чат войса — «Назад» из чата ведёт туда, откуда пришли, а не в сам войс. */
  const retChat = useRef(false);
  /** Текстовый чат, поверх которого открыли войс из виджета: лежит под войсом и виден, пока войс уезжает. */
  const [below, setBelow] = useState<Channel | null>(null);
  /** Чат под войсом другого сервера: пока открыт войс, приложение на сервере войса и чат того сервера
   *  пустеет и грузится заново. Под войсом и после «Назад», пока история не пришла, показываем снимок. */
  const frozen = useRef<{ chat: AppState['general']; room: string; sub: string } | null>(null);
  /** После возврата присутствие («N в сети») сервера приходит заново и число скачет — держим прежнюю подпись ещё чуть-чуть. */
  const [heldSub, setHeldSub] = useState<string | null>(null);
  const heldTimer = useRef<number | undefined>(undefined);
  const holdSub = (v: string) => {
    if (heldTimer.current) return;
    heldTimer.current = window.setTimeout(() => {
      heldTimer.current = undefined;
      setHeldSub(null);
    }, 1500);
    setHeldSub(v);
  };
  useEffect(() => () => window.clearTimeout(heldTimer.current), []);
  useEffect(() => {
    if (!open || open.kind !== 'voice') {
      ret.current = null;
      overVoice.current = false;
      holdUnder.current = false;
      holdVoice.current = false;
      setBelow(null);
    }
  }, [open]);
  /** here — нажали на название в виджете: «Назад» вернёт в то же окно. Иначе («Вернуться в войс») — на экран сервера. */
  /** Сервер, на который вернуться из войса, открытого из виджета. */
  const retSid = useRef<string | null>(null);
  /** Экраны под войсом заморожены (см. Hold): войс другого сервера. */
  const holdUnder = useRef(false);
  /** Уезжающий войс заморожен: сервер уже вернули, а он должен уехать таким, каким был. */
  const holdVoice = useRef(false);
  /** «Назад» из войса, открытого из виджета: сервер возвращаем сразу, чтобы экраны под войсом успели загрузиться, пока он уезжает. */
  const backFromVoice = () => {
    const back = ret.current;
    if (!back || leaving) return;
    if (retSid.current && retSid.current !== lastSrv.current) {
      holdVoice.current = true;
      srvQuiet.current = true;
      app.setServerId(retSid.current as ServerId);
    }
    close('voice', back);
  };
  const openVoice = (withChat = false, here = false) => {
    const onVoice = !!open && open.kind === 'voice';
    if (!onVoice && !here && !withChat) {
      ret.current = null;
      setBelow(null);
      setTab('servers');
    } else if (!onVoice) {
      // Войс встаёт поверх того, что открыто: под ним ничего не закрывается и не открывается заново
      retChat.current = withChat;
      const was = { open, sid: app.serverId };
      const keep = { chat: !!open, members, home: settingsHome, settings: !!settings, shome: serverHome, ssec: !!serverSection };
      setBelow(open && open.kind === 'text' ? open : null);
      frozen.current =
        open && open.kind === 'text' && app.voice.server && app.voice.server !== app.serverId
          ? { chat: app.general, room: open.room, sub: app.membersReady ? `${online.length} в сети` : ' ' }
          : null;
      overVoice.current = !!open || members || settingsHome || !!settings || serverHome || !!serverSection;
      retSid.current = was.sid;
      markForward();
      ret.current = () => {
        if (was.sid !== lastSrv.current) {
          srvQuiet.current = true;
          app.setServerId(was.sid as ServerId);
        }
        markReturn();
        // экраны под войсом встают на место без въезда
        for (const [k, on] of Object.entries(keep)) if (on) quiet.current.add(k);
        setOpen(was.open);
        setVoiceChat(false);
      };
      if (app.voice.server && app.voice.server !== app.serverId) {
        srvQuiet.current = true;
        holdUnder.current = true;
        app.setServerId(app.voice.server as ServerId);
      }
      setChatMenu(false);
      setVoiceChat(withChat);
      if (voiceCh) setOpen(voiceCh);
      return;
    } else if (!withChat) {
      // уже в войсе (например, в его чате) — просто к сцене войса
      retChat.current = false;
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

  /** Текстовый чат на экране: открытый или лежащий под войсом (см. below). */
  const chatCh = open?.kind === 'text' ? open : open?.kind === 'voice' && below ? below : null;
  // снимок больше не нужен: чат закрыт или его история снова загружена
  if (frozen.current && (!chatCh || (open?.kind === 'text' && app.general.room === frozen.current.room))) {
    if (chatCh) holdSub(frozen.current.sub);
    frozen.current = null;
  }
  const chat = frozen.current?.chat ?? app.general;
  /** Экраны под войсом, открытым из виджета: спрятаны, пока войс на месте. */
  const belowVoice = open?.kind === 'voice' && overVoice.current ? ' m-below' : '';

  // Адрес ↔ экраны. Порядок важен: чем выше экран, тем позже он задаёт адрес
  const sid = app.server.id;
  let path = tab === 'chats' ? paths.chats() : tab === 'you' ? paths.you() : paths.server(sid);
  if (members) path = paths.members(sid);
  if (open) path = paths.channel(sid, open.id, open.kind === 'voice' && voiceChat);
  if (serverHome) path = paths.serverSettings(sid);
  if (serverSection) path = paths.serverSettings(sid, serverSection);
  if (settingsHome) path = paths.settings();
  if (settings) path = paths.settings(settings);
  if (open && open.kind === 'voice' && overVoice.current) path = paths.channel(sid, open.id, voiceChat);
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
    // Войс, открытый из виджета поверх других экранов, закрыли «Назад» браузера или телефона —
    // возвращаемся так же, как кнопкой: экраны под ним остаются на месте, а не открываются заново
    if (open && open.kind === 'voice' && ret.current && want.open?.id !== open.id) {
      backFromVoice();
      return;
    }
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
        onOpenHere={() => openVoice(false, true)}
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
          <Hold hold={holdUnder.current}>
          <h2 className="m-tab-title">Серверы</h2>
          <div className="m-servers-row">
          <Rail app={app} home={false} noHome onHome={() => setTab('chats')} onServer={(id: ServerId) => app.setServerId(id)} />
          <aside className={'sidebar glass' + (srvSwitch ? ' srv-switch' : '')}>
            <div className="sidebar-head">
              <button className="grow srv-name" title="Настройки сервера" onClick={() => setServerHome(true)}>
                <span key={app.server.id}>{app.server.name}</span>
                <Icon name="chevron-down" size={18} />
              </button>
              <button className="icon-btn srv-members" title="Участники" aria-label="Участники" onClick={() => setMembers(true)}>
                <Icon key={app.server.id} name="users" />
              </button>
            </div>
            <div className="sidebar-scroll">
              <div key={app.server.id} className="srv-channels">
              <ChannelList
                app={app}
                active={null}
                onOpen={(c) => {
                  setOpen(c);
                  if (c.kind === 'voice') app.joinVoice();
                }}
              />
              </div>
            </div>
          </aside>
          </div>
          </Hold>
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
          {/* Профиль (Figma «Mobile · You»): статус, профиль; настройки — отдельным экраном */}
          <div className="m-list glass">
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
      <nav ref={navRef} className={'tabbar glass' + underMain}>
        {/* Подсветка активной вкладки — одна на всю панель, упругий пузырь (см. useJellyTabs) */}
        <span ref={gliderRef} className="tab-glider" aria-hidden="true" />
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

      {chatCh && (
        <div className={'m-full m-full-chat' + (chatCh !== open ? ' m-below' : slide('chat'))} aria-hidden={chatCh !== open || undefined}>
          <Hold hold={holdUnder.current}>
          <Head
            title={chatCh.name}
            icon="chats"
            onBack={() => close('chat', () => setOpen(null))}
            actions={
              <>
                <button className="icon-btn" title="Поиск" aria-label="Поиск" onClick={() => app.notify('Поиск по каналу — скоро будет')}>
                  <Icon name="search" />
                </button>
                <button className={'icon-btn' + (chatMenu ? ' active' : '')} title="Ещё" aria-label="Ещё" aria-expanded={chatMenu} onClick={() => setChatMenu((v) => !v)}>
                  <Icon name="more" />
                </button>
              </>
            }
            sub={<TypingLine users={chat.typingUsers.filter((u) => u !== app.name)} fallback={frozen.current?.sub ?? heldSub ?? (app.membersReady ? `${online.length} в сети` : ' ')} />}
          />
          <ChatBody app={app} chat={chat} channel={chatCh} compact />
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
                      if (it.label === 'Закреплённые') chat.setView('pinned');
                      else if (it.label === 'Копировать название') {
                        void navigator.clipboard?.writeText(`#${chatCh.name}`).then(
                          () => app.notify('Название канала скопировано', 'success'),
                          () => app.notify('Не удалось скопировать', 'error'),
                        );
                      } else app.notify(it.soon!);
                    }}
                  >
                    <Icon name={it.icon} />
                    <span>{it.label}</span>
                    {it.label === 'Закреплённые' && chat.pinned.length > 0 && <span className="m-menu-count">{chat.pinned.length}</span>}
                  </button>
                ))}
              </div>
            </>
          )}
          </Hold>
        </div>
      )}

      {open && open.kind === 'voice' && (
        <div className={'m-full m-full-voice' + (vchatShown ? ' with-chat' : '') + (overVoice.current ? ' m-over' : '') + slide('voice')}>
          <Hold hold={holdVoice.current}>
          <Head
            swapKey={vchatShown ? 'chat' : 'voice'}
            title={vchatShown ? `Чат · ${open.name}` : open.name}
            icon={vchatShown ? 'chats' : 'voice'}
            onBack={() => {
              const back = ret.current;
              if (voiceChat && !(back && retChat.current)) close('vchat', () => setVoiceChat(false));
              else if (back) backFromVoice();
              else close('voice', () => setOpen(null));
            }}
            sub={
              app.inVoiceHere && app.voice.state === 'connected' ? (
                <>
                  {/* Точка — тот же статус связи, что и значок Wi‑Fi в панели «Подключено» */}
                  {/* Узкий экран: «Подключено» уже сказано точкой — когда пинг известен, слово не пишем, иначе хвост строки
                      (таймер) обрезался шапкой */}
                  <i className={`live-dot q-${app.voice.quality}`} />
                  {app.voice.rtt != null ? `${app.voice.rtt} мс` : 'Подключено'}
                  {` · ${app.voice.peers.length} в канале`}
                  <Elapsed from={app.voice.startedAt} prefix=" · " />
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
          </Hold>
        </div>
      )}

      {members && (
        <div className={'m-full m-members' + belowVoice + slide('members')}>
          <Hold hold={holdUnder.current}>
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
          </Hold>
        </div>
      )}

      {card && (
        <MemberCard
          key={card}
          sheet
          serverIcon={{ short: app.server.short, gradient: app.server.gradient }}
          onCall={() => app.notify('Личные звонки — скоро будут')}
          name={card}
          me={card === app.name}
          at={{ x: 0, y: 0 }}
          status={app.statusOf(card)}
          activity={app.voiceUsers.some((v) => v.identity === card) ? `В голосовом · ${voiceName}` : STATUS_LABEL[app.statusOf(card)]}
          serverName={app.server.name}
          since={cardMember?.joinedAt ? new Date(cardMember.joinedAt) : new Date()}
          onClose={() => setCard(null)}
          full={<ProfileDetails app={app} name={card} onClose={() => setCard(null)} />}
          onProfile={() => {
            const mine = card === app.name;
            setCard(null);
            if (mine) setSettings('account-edit');
            else openProfile(card);
          }}
        />
      )}

      {settingsHome && (
        <div className={'m-settings' + belowVoice + slide('home')}>
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
              {USER_NAV.slice(0, USER_NAV.findIndex((x) => x.group)).map((n) => (
                <button key={n.id} className="m-item" onClick={() => setSettings(n.id)}>
                  <Icon name={n.icon} />
                  <span className="grow">{n.label}</span>
                  <Icon name="chevron-right" size={18} />
                </button>
              ))}
            </div>
            <div className="overline m-group-title">Приложение</div>
            <div className="m-list glass">
              {USER_NAV.slice(USER_NAV.findIndex((x) => x.group)).map((n) => (
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
        <div className={'m-settings' + belowVoice + slide('shome')}>
          <Hold hold={holdUnder.current}>
          <Head title="Настройки сервера" onBack={() => close('shome', () => setServerHome(false))} />
          <div className="m-settings-home">
            <div className="m-list glass">
              {SERVER_NAV.filter((n) => !n.group && n.id !== 'moderation').map((n) => (
                <button
                  key={n.id}
                  className="m-item"
                  data-ico={n.icon}
                  onClick={(e) => {
                    pressIcon(e.currentTarget);
                    setServerSection(n.id);
                  }}
                >
                  <span className="si">{n.icon === 'settings' ? <SlidersIcon /> : n.icon === 'chats' ? <ChatsIcon /> : <Icon name={n.icon} />}</span>
                  <span className="grow">{n.label}</span>
                  <Icon name="chevron-right" size={18} />
                </button>
              ))}
            </div>
            <div className="overline m-group-title">Модерация</div>
            <div className="m-list glass">
              {SERVER_NAV.filter((n) => n.group || n.id === 'moderation').map((n) => (
                <button
                  key={n.id}
                  className="m-item"
                  data-ico={n.icon}
                  onClick={(e) => {
                    pressIcon(e.currentTarget);
                    setServerSection(n.id);
                  }}
                >
                  <span className="si">{n.icon === 'settings' ? <SlidersIcon /> : n.icon === 'chats' ? <ChatsIcon /> : <Icon name={n.icon} />}</span>
                  <span className="grow">{n.label}</span>
                  <Icon name="chevron-right" size={18} />
                </button>
              ))}
            </div>
          </div>
          </Hold>
        </div>
      )}

      {serverSection && (
        <div className={'m-settings' + belowVoice + slide('ssec')}>
          <Hold hold={holdUnder.current}>
          <Head title={SERVER_NAV.find((n) => n.id === serverSection)?.label ?? 'Сервер'} fromTitle="Настройки сервера" onBack={() => close('ssec', () => setServerSection(null))} />
          <div className="settings-body" style={{ overflowY: 'auto' }}>
            <ServerSettingsBody app={app} section={serverSection} />
          </div>
          </Hold>
        </div>
      )}

      {settings && (
        <div className={'m-settings' + belowVoice + slide('settings')}>
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
