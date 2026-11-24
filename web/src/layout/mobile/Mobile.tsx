import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { markForward, markReturn, parseRoute, paths, useUrlSync } from '../../app/router';
import type { AppState } from '../../app/useAppState';
import { STATUS_ITEMS } from '../../features/account/AccountMenu';
import { presenceLine } from '../../features/account/status';
import { ChatBody, PinnedButton } from '../../features/chat/ChatBody';
import { ChatInfo } from '../../features/chat/ChatInfo';
import { setMuted, useMuted } from '../../features/notifications/mute';
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
import { useServerSwipe } from './serverSwipe';
import { useStageSwipes } from './swipes';
import { useJellyTabs, useSettled, useTabShadeClip } from './tabs';
import { t } from '../../shared/i18n';

type Tab = 'servers' | 'chats' | 'you';

/** Screen slide duration (chat, voice, members, settings); matches the CSS animation. */
const SLIDE_MS = 220;
export const SLIDE_IN_MS = 340;

const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: 'servers', get label() { return t('Серверы'); }, icon: 'servers' },
  { id: 'chats', get label() { return t('Чаты'); }, icon: 'oreol' },
  { id: 'you', get label() { return t('Вы'); }, icon: 'users' },
];

const CHAT_MENU: { icon: IconName; label: string }[] = [
  { icon: 'pin', get label() { return t('Закреплённые'); } },
  { icon: 'bell', get label() { return t('Уведомления'); } },
  { icon: 'copy', get label() { return t('Копировать название'); } },
];

/**
 * While hold is set the content does not re-render (React reuses the last result). Screens under another
 * server's voice opened from the widget keep showing their own server although the app is already on the voice one.
 */
const Hold = memo(
  function Hold({ children }: { hold: boolean; children: ReactNode }) {
    return <>{children}</>;
  },
  (_prev, next) => next.hold,
);

const LAND_QUERY = '(pointer: coarse) and (orientation: landscape) and (max-height: 520px)';
function useLandscape() {
  const [on, setOn] = useState(() => matchMedia(LAND_QUERY).matches);
  useEffect(() => {
    const mq = matchMedia(LAND_QUERY);
    const upd = () => setOn(mq.matches);
    mq.addEventListener('change', upd);
    return () => mq.removeEventListener('change', upd);
  }, []);
  return on;
}

/** true only if on holds longer than ms, so short reconnects do not flicker. */
function useLagged(on: boolean, ms: number) {
  const [v, setV] = useState(false);
  useEffect(() => {
    if (!on) return void setV(false);
    const id = window.setTimeout(() => setV(true), ms);
    return () => window.clearTimeout(id);
  }, [on, ms]);
  return v;
}

export function Mobile({ app }: { app: AppState }) {
  const stageRef = useRef<HTMLDivElement>(null);
  useTabShadeClip(stageRef);
  const [tab, setTab] = useState<Tab>('servers');
  // During the back swipe the lower screen renders again and appears under the sliding upper one.
  const [peek, setPeek] = useState(false);
  // The icon bounce plays only on tab taps, not when the tab bar reappears (leaving voice or chat).
  const [hop, setHop] = useState<Tab | null>(null);
  const hopTimer = useRef(0);
  const tabInTimer = useRef(0);
  const pickTab = (t: Tab) => {
    if (t !== tab) {
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
  useEffect(() => {
    const edit = () => setSettings('account-edit');
    window.addEventListener(EDIT_PROFILE_EVENT, edit);
    return () => window.removeEventListener(EDIT_PROFILE_EVENT, edit);
  }, []);
  const [members, setMembers] = useState(false);
  const [chatMenu, setChatMenu] = useState(false);
  const [chatInfo, setChatInfo] = useState<{ search: boolean } | null>(null);
  const [settingsHome, setSettingsHome] = useState(false);
  const [serverHome, setServerHome] = useState(false);
  const [serverSection, setServerSection] = useState<ServerSection | null>(null);
  const [card, setCard] = useState<string | null>(null);
  const lastSrv = useRef(app.server.id);
  /**
   * When the server changed. The animation class is short-lived, otherwise it stuck and the channels re-animated
   * every time the list appeared again (Back from chat, voice, settings).
   */
  const srvSwitchAt = useRef(0);
  /** The server changed because of the widget (opened another server's voice or came back): no switch animation. */
  const srvQuiet = useRef(false);
  const wantSlide = useRef(false);
  if (lastSrv.current !== app.server.id) {
    lastSrv.current = app.server.id;
    wantSlide.current = !srvQuiet.current && tab === 'servers';
    if (!srvQuiet.current && tab === 'servers') srvSwitchAt.current = Date.now();
    srvQuiet.current = false;
  }
  const srvSwitch = tab === 'servers' && Date.now() - srvSwitchAt.current < 700;
  const srvDir = useRef<1 | -1>(1);
  const prevSrv = useRef(app.server.id);
  /** Snapshot of the previous server's channel panel that slides away on top while the new one slides in. */
  const stackRef = useRef<HTMLDivElement>(null);
  const outgoing = useRef<{ node: HTMLElement; dir: 1 | -1 } | null>(null);
  if (prevSrv.current !== app.server.id) {
    const ids = app.servers.map((x) => x.id);
    srvDir.current = ids.indexOf(app.server.id) >= ids.indexOf(prevSrv.current) ? 1 : -1;
    prevSrv.current = app.server.id;
    // During render the DOM still holds the old panel: copy it (with the offset where the finger released it).
    const old = wantSlide.current ? stackRef.current?.querySelector<HTMLElement>(':scope > .sidebar') : null;
    if (old) outgoing.current = { node: old.cloneNode(true) as HTMLElement, dir: srvDir.current };
    wantSlide.current = false;
  }
  useLayoutEffect(() => {
    const out = outgoing.current;
    outgoing.current = null;
    const stack = stackRef.current;
    const cur = stack?.querySelector<HTMLElement>(':scope > .sidebar');
    if (!out || !stack || !cur) return;
    const from = out.node.style.transform || 'translateY(0)';
    const fromOp = out.node.style.opacity || '1';
    out.node.style.transition = out.node.style.transform = out.node.style.opacity = '';
    out.node.classList.add('srv-out');
    out.node.setAttribute('aria-hidden', 'true');
    out.node.querySelectorAll('[key], [id]').forEach((n) => n.removeAttribute('id'));
    stack.appendChild(out.node);
    cur.style.transition = cur.style.transform = cur.style.opacity = '';
    // The old panel briefly moves away and fades, the new one floats in from the side the finger moved to.
    // A full-height flight was choppy: the glass of both panels recomputed its blur every frame.
    const ease = 'cubic-bezier(.25, .8, .3, 1)';
    const ms = 420;
    const away = out.dir === 1 ? 'translateY(-90px)' : 'translateY(90px)';
    const come = out.dir === 1 ? 'translateY(120px)' : 'translateY(-120px)';
    out.node.animate([{ transform: from, opacity: fromOp }, { transform: away, opacity: 0 }], { duration: 170, easing: 'cubic-bezier(.2, 0, .4, 1)', fill: 'forwards' });
    const a = cur.animate([{ transform: come, opacity: 0 }, { opacity: 1, offset: 0.55 }, { transform: 'translateY(0)', opacity: 1 }], { duration: ms, easing: ease });
    const done = () => out.node.remove();
    a.onfinish = done;
    a.oncancel = done;
    const id = window.setTimeout(done, ms + 120);
    return () => window.clearTimeout(id);
  }, [app.server.id]);
  const srvIdx = app.servers.findIndex((x) => x.id === app.server.id);
  useServerSwipe(stageRef, {
    can: (dir) => !!app.servers[srvIdx + dir],
    go: (dir) => {
      const next = app.servers[srvIdx + dir];
      if (next) app.setServerId(next.id as ServerId);
    },
  });
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
  // Hide the lower screen only once the upper one has fully slid in, otherwise it is empty underneath during the animation.
  // Settings screens count as upper screens too: their background is transparent (the torus shows), so the screen below fades.
  const settingsOpen = [settingsHome, serverHome, !!settings, !!serverSection].filter(Boolean).length;
  const top = !!open || members || settingsOpen > 0;
  const settled = useSettled(top);
  /** Voice opened from the widget over the current screens (chat, members, settings): they stay under it as they are. */
  const overVoice = useRef(false);
  // Only the top screen itself slides away (not a nested one such as the lobby chat inside voice or a settings section).
  const leavingTop =
    leaving === 'chat' ||
    (leaving === 'voice' && !overVoice.current) ||
    leaving === 'members' ||
    (settingsOpen === 1 && (leaving === 'home' || leaving === 'shome' || leaving === 'ssec' || leaving === 'settings'));
  const covered = top && settled && !leavingTop && !peek;
  const quiet = useRef(new Set<string>());
  const firstApply = useRef(true);
  const slide = (key: string) => (leaving === key ? ' m-slide out' : ' m-slide' + (quiet.current.has(key) ? ' m-quiet' : ''));
  // Chat or voice open: dim the torus. body:has(...) used to do this, but that rule made the browser restyle the whole
  // page on every node insertion and chat history loading stuttered on phones.
  useLayoutEffect(() => {
    const on = !!document.querySelector('.m-full-chat:not(.out), .m-full-voice:not(.out)');
    if (document.body.classList.contains('m-chat-open') !== on) document.body.classList.toggle('m-chat-open', on);
  });
  useEffect(() => () => document.body.classList.remove('m-chat-open'), []);
  /**
   * Lower screen: fades out while the upper one slides in and fades in while it slides out
   * (otherwise it visibly vanishes through the transparent background).
   */
  const under = (hidden: boolean, back: boolean) => ' m-under' + (hidden ? ' dim' : '') + (back ? ' back' : '');
  const underMain = under(top && !leavingTop, top && leavingTop);
  // Lobby chat over the voice stage: remove the stage only after the chat has fully slid in.
  const vchatSettled = useSettled(voiceChat);
  const showStage = !voiceChat || !vchatSettled || leaving === 'vchat';
  /** The header switches on tap (both opening and Back) without waiting for the slide to end. */
  const vchatShown = voiceChat && leaving !== 'vchat';

  const voiceCh = (app.serverById(app.voice.server) ?? app.server).channels.find((c) => c.kind === 'voice') ?? app.voiceChannel;
  const voiceName = voiceCh?.name ?? t('Голосовой');
  const cardMember = card ? app.members.find((m) => m.username === card) : undefined;

  const [callMinPref, setCallMin] = useState(false);
  // In landscape the screen is short: the call widget is always a pill (expanded it took half the screen).
  const land = useLandscape();
  const callMin = callMinPref || land;
  const [callMenu, setCallMenu] = useState<{ top: number; right: number } | null>(null);
  const inCall = app.voice.state !== 'idle';
  useEffect(() => {
    if (!inCall) {
      setCallMin(false);
      setCallMenu(null);
    }
  }, [inCall]);
  /**
   * The voice screen we are in is open, so the widget slides up. While that screen slides away the widget stays hidden:
   * first the screen closes, then the widget slides down separately (together they fought and stuttered).
   */
  // The widget starts sliding when the voice screen is almost gone, not after it stops (that felt late).
  const [voiceGoing, setVoiceGoing] = useState(false);
  useEffect(() => {
    if (leaving !== 'voice') return void setVoiceGoing(false);
    const id = window.setTimeout(() => setVoiceGoing(true), Math.round(SLIDE_MS * 0.55));
    return () => window.clearTimeout(id);
  }, [leaving]);
  const onOwnVoice = !!open && open.kind === 'voice' && app.inVoiceHere && !voiceGoing;
  const [callSize, setCallSize] = useState<{ h: number | null; drag: number | null }>({ h: null, drag: null });
  /**
   * Space taken by the widget at the top: its height when expanded, the strip under the pill when collapsed
   * (on the You tab the pill sits on the banner), nothing on our own voice screen.
   */
  const pillSpace = tab === 'you' ? 0 : PILL_SPACE;
  /**
   * On the You tab the stage does not move under the pill (the profile must not jump when settings close);
   * only screens opened on top get the pill offset.
   */
  const pillOver = inCall && callMin && !onOwnVoice && tab === 'you' && top;
  const callH = callSize.h ?? 0;
  /** Animate the height only when the widget itself collapses, expands or leaves; on tab changes screens settle instantly. */
  const [callAnim, setCallAnim] = useState(false);
  const animKey = `${inCall}:${callMin}:${onOwnVoice}`;
  const lastAnimKey = useRef(animKey);
  useLayoutEffect(() => {
    if (lastAnimKey.current === animKey) return;
    lastAnimKey.current = animKey;
    setCallAnim(true);
    const id = window.setTimeout(() => setCallAnim(false), 560);
    return () => window.clearTimeout(id);
  }, [animKey]);
  const callSpace = !inCall || onOwnVoice ? 0 : callSize.drag != null ? Math.max(pillSpace, callH + callSize.drag) : callMin ? pillSpace : callH;
  const ret = useRef<null | (() => void)>(null);
  const retChat = useRef(false);
  const [below, setBelow] = useState<Channel | null>(null);
  /**
   * Chat under another server's voice: while voice is open the app is on the voice server and that chat empties
   * and reloads. Under voice and after Back, until history arrives, a snapshot is shown.
   */
  const frozen = useRef<{ chat: AppState['general']; room: string; sub: string } | null>(null);
  /** After returning, the server's presence count arrives again and jumps; keep the old label a little longer. */
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
  const retSid = useRef<string | null>(null);
  const holdUnder = useRef(false);
  /** The leaving voice screen is frozen: the server is already switched back, but it must slide away as it was. */
  const holdVoice = useRef(false);
  /** Back from voice opened from the widget: switch the server back at once so screens below load while it slides away. */
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
      // Voice goes on top of whatever is open: nothing below closes or reopens.
      retChat.current = withChat;
      const was = { open, sid: app.serverId };
      const keep = { chat: !!open, members, home: settingsHome, settings: !!settings, shome: serverHome, ssec: !!serverSection };
      setBelow(open && open.kind === 'text' ? open : null);
      frozen.current =
        open && open.kind === 'text' && app.voice.server && app.voice.server !== app.serverId
          ? { chat: app.general, room: open.room, sub: app.membersReady ? t('{0} в сети', { 0: online.length }) : ' ' }
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

  const chatCh = open?.kind === 'text' ? open : open?.kind === 'voice' && below ? below : null;
  if (frozen.current && (!chatCh || (open?.kind === 'text' && app.general.room === frozen.current.room))) {
    if (chatCh) holdSub(frozen.current.sub);
    frozen.current = null;
  }
  const chat = frozen.current?.chat ?? app.general;
  const chatMuted = useMuted(chatCh?.room);
  useEffect(() => setChatInfo(null), [chatCh?.room, open]);
  const chatOffline = useLagged(!!chatCh && !chat.connected && !frozen.current, 700);
  const belowVoice = open?.kind === 'voice' && overVoice.current ? ' m-below' : '';

  // URL and screens. Order matters: higher screens set the URL later.
  const sid = app.server.id;
  let path = tab === 'chats' ? paths.chats() : tab === 'you' ? paths.you() : paths.server(sid);
  if (members) path = paths.members(sid);
  if (open) path = paths.channel(sid, open.id, open.kind === 'voice' && voiceChat);
  if (serverHome) path = paths.serverSettings(sid);
  if (serverSection) path = paths.serverSettings(sid, serverSection);
  if (settingsHome) path = paths.settings();
  if (settings) path = paths.settings(settings);
  if (open && open.kind === 'voice' && overVoice.current) path = paths.channel(sid, open.id, voiceChat);
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
    // Voice opened from the widget was closed with the browser or phone Back:
    // return the same way as the button does, screens below stay in place instead of reopening.
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
  const quietReady = useRef(false);
  useEffect(() => {
    // The first pass runs in the same commit as URL parsing while state is still empty; skip it.
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
      className={'m-app' + (app.glassChat ? ' glass-chat' : '') + (app.glassVoice ? ' glass-voice' : '') + (pillOver ? ' pill-over' : '') + (callSize.drag != null ? ' call-drag' : (callAnim || lastAnimKey.current !== animKey) && !onOwnVoice ? ' call-anim' : '')}
      style={{ '--call-h': `${callSpace}px`, '--call-h-to': `${callSpace}px` } as React.CSSProperties}
    >
      <MobileCall
        app={app}
        gone={onOwnVoice}
        min={callMin}
        onMin={() => setCallMin(true)}
        onOpen={() => openVoice()}
        onOpenHere={() => openVoice(false, true)}
        onMeasure={(h, drag) => setCallSize((s) => (s.h === h && s.drag === drag ? s : { h, drag }))}
        // Microphone highlight in the widget everywhere except the channel list of our voice server (the list itself glows there).
        liveMic={covered || tab !== 'servers' || app.serverId !== app.voice.server}
        onMore={(btn) => {
          const r = btn.getBoundingClientRect();
          setCallMenu((m) => (m ? null : { top: r.bottom + 8, right: Math.max(12, window.innerWidth - r.right) }));
        }}
      />
      <MobileCallPill app={app} shown={inCall && callMin && !onOwnVoice} onExpand={() => (land ? openVoice() : setCallMin(false))} />
      {callMenu && (
        <>
          <div className="popover-backdrop m-menu-backdrop" onClick={() => setCallMenu(null)} />
          <div className="m-menu glass m-call-menu" role="menu" style={{ top: callMenu.top, right: callMenu.right }}>
            <button role="menuitem" className={'m-menu-item' + (app.voice.screenOn ? ' share-on' : '')} onClick={() => { setCallMenu(null); void app.voice.toggleScreen(); }}>
              <Icon name={app.voice.screenOn ? 'screen-share-stop' : 'screen-share'} />
              <span>{app.voice.screenOn ? t('Остановить демонстрацию') : t('Демонстрация экрана')}</span>
            </button>
            <button role="menuitem" className="m-menu-item" onClick={() => { setCallMenu(null); openVoice(true); }}>
              <Icon name="chats" />
              <span>{t('Чат канала')}</span>
            </button>
            <button role="menuitem" className="m-menu-item" onClick={() => { setCallMenu(null); setSettings('voice'); }}>
              <Icon name="settings" />
              <span>{t('Голос и звук')}</span>
            </button>
          </div>
        </>
      )}
      <div className="m-stage" ref={stageRef}>
      {!covered && tab === 'servers' && (
        <div className={'m-servers' + underMain}>
          <Hold hold={holdUnder.current}>
          <h2 className="m-tab-title">{t('Серверы')}</h2>
          <div className="m-servers-row">
          <Rail app={app} home={false} noHome onHome={() => setTab('chats')} onServer={(id: ServerId) => app.setServerId(id)} />
          <div className="srv-stack" ref={stackRef}>
          <aside className={'sidebar glass' + (srvSwitch ? ' srv-switch' : '')} data-srv-dir={srvDir.current === 1 ? 'next' : 'prev'}>
            <div key={app.server.id} className="srv-body">
            <div className="sidebar-head">
              <div className="grow srv-name">
                <span key={app.server.id}>{app.server.name}</span>
                <button type="button" className="icon-btn srv-arrow" title={t('Настройки сервера')} aria-label={t('Настройки сервера')} onClick={() => setServerHome(true)}>
                  <Icon name="chevron-down" size={18} />
                </button>
              </div>
              <button className="icon-btn srv-members" title={t('Участники')} aria-label={t('Участники')} onClick={() => setMembers(true)}>
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
            </div>
          </aside>
          </div>
          </div>
          </Hold>
        </div>
      )}

      {!covered && tab === 'chats' && (
        <div className={'m-section' + underMain}>
          <h2>{t('Чаты')}</h2>
          <div className="empty-state" style={{ marginTop: 32, fontSize: 13 }}>
            <b>{t('Личных сообщений пока нет')}</b>
            {t('Здесь будут ваши диалоги и групповые чаты. Чаты серверов находятся во вкладке «Серверы».')}
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
            <div className="overline">{t('Статус')}</div>
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
          <div className="m-list glass">
            <button className="m-item" onClick={() => setSettings('account-edit')}>
              <Icon name="pencil" />
              <span className="grow">{t('Редактировать профиль')}</span>
              <Icon name="chevron-right" size={18} />
            </button>
            <button className="m-item" onClick={() => setSettings('appearance')}>
              <Icon name="appearance" />
              <span className="grow">{t('Внешний вид')}</span>
              <Icon name="chevron-right" size={18} />
            </button>
            <button className="m-item" onClick={() => setSettingsHome(true)}>
              <Icon name="settings" />
              <span className="grow">{t('Настройки')}</span>
              <Icon name="chevron-right" size={18} />
            </button>
          </div>
          <div className="m-list glass">
            <button className="m-item danger" onClick={app.logout}>
              <Icon name="logout" />
              <span className="grow">{t('Выйти')}</span>
            </button>
          </div>
        </div>
      )}

      {!covered && (
      <nav ref={navRef} className={'tabbar glass' + underMain}>
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
            onTitle={() => setChatInfo({ search: false })}
            onBack={() => close('chat', () => setOpen(null))}
            actions={
              <>
                <button className="icon-btn" title={t('Поиск')} aria-label={t('Поиск')} onClick={() => setChatInfo({ search: true })}>
                  <Icon name="search" />
                </button>
                <button className={'icon-btn' + (chatMenu ? ' active' : '')} title={t('Ещё')} aria-label={t('Ещё')} aria-expanded={chatMenu} onClick={() => setChatMenu((v) => !v)}>
                  <Icon name="more" />
                </button>
              </>
            }
            sub={
              chatOffline ? (
                <span className="m-connecting">
                  <i className="conn-spin" />
                  {t('Подключение…')}
                </span>
              ) : (
                <TypingLine users={chat.typingUsers.filter((u) => u !== app.name)} fallback={frozen.current?.sub ?? heldSub ?? (app.membersReady ? t('{0} в сети', { 0: online.length }) : ' ')} />
              )
            }
          />
          <ChatBody app={app} chat={chat} channel={chatCh} compact />
          {chatInfo && chatCh === open && (
            <ChatInfo key={chatCh.room} app={app} chat={chat} channel={chatCh} full startSearch={chatInfo.search} onClose={() => setChatInfo(null)} />
          )}
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
                      if (it.label === t('Закреплённые')) chat.setView('pinned');
                      else if (it.icon === 'bell') {
                        setMuted(chatCh.room, !chatMuted);
                        app.notify(chatMuted ? t('Уведомления включены') : t('Уведомления выключены, кроме упоминаний'), 'success');
                      } else if (it.label === t('Копировать название')) {
                        void navigator.clipboard?.writeText(`#${chatCh.name}`).then(
                          () => app.notify(t('Название канала скопировано'), 'success'),
                          () => app.notify(t('Не удалось скопировать'), 'error'),
                        );
                      }
                    }}
                  >
                    <Icon name={it.icon === 'bell' && chatMuted ? 'bell-off' : it.icon} />
                    <span>{it.icon === 'bell' && chatMuted ? t('Включить уведомления') : it.icon === 'bell' ? t('Выключить уведомления') : it.label}</span>
                    {it.label === t('Закреплённые') && chat.pinned.length > 0 && <span className="m-menu-count">{chat.pinned.length}</span>}
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
            title={vchatShown ? t('Чат · {0}', { 0: open.name }) : open.name}
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
                  {/* Narrow screen: the dot already says "Connected", so the word is dropped once ping is known, otherwise the end of the line (the timer) was clipped by the header. */}
                  <i className={`live-dot q-${app.voice.quality}`} />
                  {app.voice.rtt != null ? t('{0} мс', { 0: app.voice.rtt }) : t('Подключено')}
                  {t(' · {0} в канале', { 0: app.voice.peers.length })}
                  <Elapsed from={app.voice.startedAt} prefix=" · " />
                </>
              ) : app.inVoiceHere && app.voice.state === 'connecting' ? (
                <>
                  <i className="live-dot q-medium" />
                  {t('Подключение…')}
                </>
              ) : (
                t('Голосовой канал')
              )
            }
            actions={
              vchatShown ? (
                <PinnedButton chat={app.lobby} />
              ) : (
                <button className="icon-btn has-badge" title={t('Чат канала')} aria-label={t('Чат канала')} onClick={(e) => { e.currentTarget.blur(); setVoiceChat(true); }}>
                  <Icon name="chats" />
                  <UnreadBadge n={chatUnread(app, app.lobby)} className="corner" />
                </button>
              )
            }
          />
          {/* The stage is not recreated under the chat, otherwise avatars flicker or vanish behind the glass. */}
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
          <Head title={t('Участники')} sub={app.membersReady ? t('{0} · {1} в сети', { 0: app.server.name, 1: online.length }) : app.server.name} onBack={() => close('members', () => setMembers(false))} />
          <div className="m-members-list glass">
            <div className="section-title overline">{t('В сети: ')}{online.length}</div>
            {online.map((m) => (
              <MemberRow
                key={m.username}
                name={m.username}
                me={m.username === app.name}
                status={m.status}
                sub={app.voiceUsers.some((v) => v.identity === m.username) ? t('В голосовом · {0}', { 0: voiceName }) : presenceLine(m.status, m.lastSeen)}
                onClick={() => openProfile(m.username)}
              />
            ))}
            {app.membersOffline.length > 0 && <div className="section-title overline">{t('Не в сети: ')}{app.membersOffline.length}</div>}
            {app.membersOffline.map((m) => (
              <MemberRow
                key={m.username}
                name={m.username}
                me={m.username === app.name}
                status="offline"
                sub={presenceLine('offline', m.lastSeen)}
                onClick={() => openProfile(m.username)}
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
          onCall={() => app.notify(t('Личные звонки скоро будут'))}
          name={card}
          me={card === app.name}
          at={{ x: 0, y: 0 }}
          status={app.statusOf(card)}
          activity={app.voiceUsers.some((v) => v.identity === card) ? t('В голосовом · {0}', { 0: voiceName }) : presenceLine(app.statusOf(card), app.lastSeenOf(card))}
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
          <Head title={t('Настройки')} onBack={() => close('home', () => setSettingsHome(false))} />
          <div className="m-settings-home">
            <div className="m-list glass m-account-row">
              <Avatar name={app.name} size={56} status={app.status} />
              <span className="info">
                <b>{app.name}</b>
                <span>{handleOf(app.name)}</span>
              </span>
            </div>
            <div className="overline m-group-title">{t('Настройки пользователя')}</div>
            <div className="m-list glass">
              {USER_NAV.slice(0, USER_NAV.findIndex((x) => x.group)).map((n) => (
                <button key={n.id} className="m-item" onClick={() => setSettings(n.id)}>
                  <Icon name={n.icon} />
                  <span className="grow">{n.label}</span>
                  <Icon name="chevron-right" size={18} />
                </button>
              ))}
            </div>
            <div className="overline m-group-title">{t('Приложение')}</div>
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
                <span className="grow">{t('Выйти')}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {serverHome && (
        <div className={'m-settings' + belowVoice + slide('shome')}>
          <Hold hold={holdUnder.current}>
          <Head title={t('Настройки сервера')} onBack={() => close('shome', () => setServerHome(false))} />
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
            <div className="overline m-group-title">{t('Модерация')}</div>
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
          <Head title={SERVER_NAV.find((n) => n.id === serverSection)?.label ?? t('Сервер')} fromTitle={t('Настройки сервера')} onBack={() => close('ssec', () => setServerSection(null))} />
          <div className="settings-body" style={{ overflowY: 'auto' }}>
            <ServerSettingsBody app={app} section={serverSection} />
          </div>
          </Hold>
        </div>
      )}

      {settings && (
        <div className={'m-settings' + belowVoice + slide('settings')}>
          <Head title={userSectionTitle(settings)} fromTitle={settingsHome ? t('Настройки') : undefined} onBack={() => close('settings', () => setSettings(null))} />
          <div className="settings-body" style={{ overflowY: 'auto' }}>
            <UserSettingsBody app={app} section={settings} onSection={setSettings} />
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
