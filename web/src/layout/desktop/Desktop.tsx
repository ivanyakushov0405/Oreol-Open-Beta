import { useEffect, useRef, useState } from 'react';
import { parseRoute, paths, useUrlSync } from '../../app/router';
import type { AppState } from '../../app/useAppState';
import { UserPanel } from '../../features/account/UserPanel';
import { presenceLine } from '../../features/account/status';
import { ChatBody, PinnedButton } from '../../features/chat/ChatBody';
import { ChatInfo } from '../../features/chat/ChatInfo';
import { setMuted, useMuted } from '../../features/notifications/mute';
import { TypingLine } from '../../features/chat/TypingLine';
import { chatUnread, UnreadBadge } from '../../features/chat/unread';
import { MemberCard } from '../../features/members/MemberCard';
import { MemberRow } from '../../features/members/MemberRow';
import { EDIT_PROFILE_EVENT, openProfile } from '../../features/profile/profile';
import { ChannelList } from '../../features/servers/ChannelList';
import { Rail } from '../../features/servers/Rail';
import { ServerSettingsBody } from '../../features/settings/ServerSettings';
import { pressIcon } from '../../features/settings/SettingsScreen';
import { SettingsScreen } from '../../features/settings/SettingsScreen';
import { UserSettingsBody } from '../../features/settings/UserSettings';
import { isServerSection, isUserSection, SERVER_NAV, USER_NAV, userNavOf, userSectionTitle, type ServerSection, type UserSection } from '../../features/settings/nav';
import { VoiceStage } from '../../features/voice/VoiceStage';
import { Elapsed, VoiceStatus } from '../../features/voice/VoiceStatus';
import { Icon } from '../../shared/icons';
import { type Channel, type ServerId } from '../../shared/model';
import { plural, t } from '../../shared/i18n';

type Overlay = { kind: 'user'; section: UserSection } | { kind: 'server'; section: ServerSection } | null;

function TitleButton({ open, disabled, onClick, children }: { open: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  if (disabled) return <div>{children}</div>;
  return (
    <button type="button" className="main-head-title" aria-haspopup="dialog" aria-expanded={open} onClick={onClick}>
      <div>{children}</div>
      <Icon name="chevron-down" size={16} className="chev" />
    </button>
  );
}

export function Desktop({ app }: { app: AppState }) {
  const [home, setHome] = useState(false);
  const [channelId, setChannelId] = useState<string | null>(null);
  const channel = app.server.channels.find((c) => c.id === channelId) ?? app.server.channels[0];
  const [showMembers, setShowMembers] = useState(true);
  const [voiceChat, setVoiceChat] = useState(false);
  /** Chat info dropdown: under the main title, or (side) under the voice channel's side chat title. */
  const [info, setInfo] = useState<{ side: boolean; search?: boolean } | null>(null);
  const muted = useMuted(channel?.room);
  useEffect(() => setInfo(null), [channel?.room, app.server.id, voiceChat]);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const [fromSettings, setFromSettings] = useState(false);
  const closeOverlay = () => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    window.setTimeout(() => {
      closingRef.current = false;
      setOverlay(null);
      setClosing(false);
      setFromSettings(true);
      window.setTimeout(() => setFromSettings(false), 320);
    }, 150);
  };
  useEffect(() => {
    const edit = () => setOverlay({ kind: 'user', section: 'account-edit' });
    window.addEventListener(EDIT_PROFILE_EVENT, edit);
    return () => window.removeEventListener(EDIT_PROFILE_EVENT, edit);
  }, []);
  const [card, setCard] = useState<{ name: string; x: number; y: number } | null>(null);

  /** Voice elapsed time: the hook must run before any return, otherwise React crashes when settings open. */
  useEffect(() => {
    if (!overlay) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeOverlay();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [overlay]);

  const sid = app.server.id;
  const path =
    overlay?.kind === 'user'
      ? paths.settings(overlay.section)
      : overlay?.kind === 'server'
        ? paths.serverSettings(sid, overlay.section)
        : home
          ? paths.chats()
          : paths.channel(sid, channel.id, channel.kind === 'voice' && voiceChat);
  useUrlSync(path, (p) => {
    const r = parseRoute(p);
    if (r.name === 'settings') {
      setOverlay({ kind: 'user', section: isUserSection(r.section) ? r.section : 'account' });
      return;
    }
    setOverlay(null);
    if (r.name === 'chats') {
      setHome(true);
      return;
    }
    setHome(false);
    if (r.name !== 'server') return;
    const srv = app.serverById(r.sid);
    if (!srv) return;
    app.setServerId(srv.id as ServerId);
    const ch = srv.channels.find((c) => c.id === r.cid);
    setChannelId(ch?.id ?? null);
    setVoiceChat(r.sub === 'chat' && ch?.kind === 'voice');
    if (r.sub === 'settings') setOverlay({ kind: 'server', section: isServerSection(r.section) ? r.section : 'overview' });
  });

  if (overlay?.kind === 'user') {
    return (
      <SettingsScreen
        title={userSectionTitle(overlay.section)}
        overline={t('Настройки пользователя')}
        nav={USER_NAV}
        section={overlay.section}
        active={userNavOf(overlay.section)}
        onSection={(s) => setOverlay({ kind: 'user', section: s })}
        onClose={closeOverlay}
        closing={closing}
        footer={
          <button className="nav-item danger" onClick={app.logout}>
            <Icon name="logout" size={18} />
            {t('Выйти')}
          </button>
        }
      >
        <UserSettingsBody app={app} section={overlay.section} onSection={(s) => setOverlay({ kind: 'user', section: s })} />
      </SettingsScreen>
    );
  }
  if (overlay?.kind === 'server') {
    return (
      <SettingsScreen
        title={SERVER_NAV.find((n) => n.id === overlay.section)!.label}
        overline={app.server.name}
        nav={SERVER_NAV}
        section={overlay.section}
        onSection={(s) => setOverlay({ kind: 'server', section: s })}
        onClose={closeOverlay}
        closing={closing}
        footer={
          <button
            className="nav-item danger"
            data-ico="trash"
            onClick={(e) => {
              pressIcon(e.currentTarget);
              app.notify(t('Удаление сервера недоступно в демо'));
            }}
          >
            <span className="si">
              <Icon name="trash" size={18} />
            </span>
            {t('Удалить сервер')}
          </button>
        }
      >
        <ServerSettingsBody app={app} section={overlay.section} />
      </SettingsScreen>
    );
  }

  const openSettings = () => setOverlay({ kind: 'user', section: 'account' });
  const openChannel = (c: Channel) => {
    setChannelId(c.id);
    if (c.kind === 'voice') app.joinVoice();
  };
  const isVoice = channel.kind === 'voice';
  const chat = isVoice ? app.lobby : app.general;
  const online = app.membersOnline;
  const cardMember = card ? app.members.find((m) => m.username === card.name) : undefined;
  const voiceName = app.voiceChannel?.name ?? t('Голосовой');

  const openCard = (name: string) => (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setCard({ name, x: r.left - 308, y: r.top });
  };

  return (
    <div className={'app' + (app.glassChat ? ' glass-chat' : '') + (app.glassVoice ? ' glass-voice' : '') + (fromSettings ? ' from-settings' : '')}>
      <Rail app={app} home={home} onHome={() => setHome(true)} onServer={(id: ServerId) => {
          setHome(false);
          app.setServerId(id);
          // Opening a server goes to its first text channel, or straight to voice if we are in its voice channel.
          const srv = app.serverById(id);
          const inHisVoice = app.voice.state !== 'idle' && app.voice.server === id;
          const ch = srv?.channels.find((c) => (inHisVoice ? c.kind === 'voice' : c.kind !== 'voice'));
          setChannelId(ch?.id ?? null);
          setVoiceChat(false);
        }} />

      <aside className="sidebar glass">
        {home ? (
          <>
            <div className="sidebar-head">{t('Личные сообщения')}</div>
            <div className="sidebar-scroll">
              <div className="empty-state" style={{ marginTop: 40, fontSize: 13 }}>
                <b>{t('Пока пусто')}</b>
                {t('Личные сообщения скоро будут')}
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="sidebar-head">
              <span>{app.server.name}</span>
              <button
                type="button"
                className="icon-btn srv-arrow"
                title={t('Настройки сервера')}
                aria-label={t('Настройки сервера')}
                onClick={() => setOverlay({ kind: 'server', section: 'overview' })}
              >
                <Icon name="chevron-down" size={18} />
              </button>
            </div>
            <div className="sidebar-scroll">
              <ChannelList app={app} active={channel.id} onOpen={openChannel} />
            </div>
          </>
        )}
        <VoiceStatus
          app={app}
          onOpen={() => {
            setHome(false);
            if (app.voice.server) app.setServerId(app.voice.server as ServerId);
            setChannelId(app.serverById(app.voice.server)?.channels.find((c) => c.kind === 'voice')?.id ?? null);
          }}
        />
        <UserPanel app={app} onStage={!home && app.inVoiceHere} onSettings={openSettings} onProfile={() => setOverlay({ kind: 'user', section: 'account-edit' })} />
      </aside>

      {home ? (
        <main className="main glass">
          <div className="main-head">
            <Icon name="chats" />
            <div className="title">{t('Личные сообщения')}</div>
          </div>
          <div className="chat">
            <div className="chat-scroll">
              <div className="empty-state">
                <b>{t('Здесь будут ваши диалоги')}</b>
                {t('Пока доступны только чаты серверов.')}
              </div>
            </div>
          </div>
        </main>
      ) : (
        <main className={'main glass' + (isVoice ? ' main-voice' : '')}>
          <div className="main-head">
            <Icon name={isVoice ? 'voice' : 'chats'} />
            <TitleButton open={info?.side === false} disabled={isVoice} onClick={() => setInfo(info ? null : { side: false })}>
              <div className="title">{channel.name}</div>
              <div className="sub">
                {isVoice ? (
                  app.inVoiceHere && app.voice.state === 'connected' ? (
                    <>
                      <i className={`live-dot q-${app.voice.quality}`} />
                      {t('Подключено · {0} в канале', { 0: app.voice.peers.length })}
                      <Elapsed from={app.inVoiceHere ? app.voice.startedAt : null} prefix=" · " />
                    </>
                  ) : app.inVoiceHere && app.voice.state === 'connecting' ? (
                    t('Подключение…')
                  ) : (
                    t('Голосовой канал')
                  )
                ) : (
                  <TypingLine users={chat.typingUsers.filter((u) => u !== app.name)} fallback={app.membersReady ? t('{0} в сети', { 0: online.length }) : ' '} />
                )}
              </div>
            </TitleButton>
            {isVoice ? (
              <div className="actions">
                <button type="button" className={'btn-chip' + (voiceChat ? ' on' : '')} onClick={() => setVoiceChat((v) => !v)}>
                  <Icon name="chats" size={16} />
                  {t('Чат канала')}
                  {!voiceChat && <UnreadBadge n={chatUnread(app, app.lobby)} />}
                </button>
              </div>
            ) : (
            <div className="actions">
              <PinnedButton chat={chat} />
              <button
                className={'icon-btn' + (muted ? ' active' : '')}
                title={muted ? t('Включить уведомления') : t('Выключить уведомления')}
                aria-pressed={muted}
                onClick={() => {
                  setMuted(channel.room, !muted);
                  app.notify(muted ? t('Уведомления включены') : t('Уведомления выключены, кроме упоминаний'), 'success');
                }}
              >
                <Icon name={muted ? 'bell-off' : 'bell'} />
              </button>
              <button className={'icon-btn' + (info?.search ? ' active' : '')} title={t('Поиск')} onClick={() => setInfo(info?.search ? null : { side: false, search: true })}>
                <Icon name="search" />
              </button>
              <button className={'icon-btn' + (showMembers ? ' active' : '')} title={t('Участники')} onClick={() => setShowMembers((s) => !s)}>
                <Icon name="users" />
              </button>
            </div>
            )}
          </div>
          {isVoice ? (
            <div className="stage">
              <VoiceStage app={app} />
            </div>
          ) : (
            <ChatBody app={app} chat={chat} channel={channel} />
          )}
          {info && !info.side && !isVoice && (
            <ChatInfo key={channel.room + (info.search ? ':s' : '')} app={app} chat={chat} channel={channel} startSearch={info.search} onClose={() => setInfo(null)} />
          )}
        </main>
      )}

      {!home && isVoice && voiceChat && (
        <aside className="side-chat glass">
          <div className="main-head">
            <Icon name="chats" />
            <TitleButton open={!!info?.side} onClick={() => setInfo(info ? null : { side: true })}>
              <div className="title">{t('Чат · ')}{voiceName}</div>
              <div className="sub">
                <TypingLine users={app.lobby.typingUsers.filter((u) => u !== app.name)} fallback={t('Видят участники голосового')} />
              </div>
            </TitleButton>
            <div className="actions">
              <PinnedButton chat={app.lobby} />
              <button className="icon-btn" title={t('Закрыть чат')} onClick={() => setVoiceChat(false)}>
                <Icon name="close" />
              </button>
            </div>
          </div>
          <ChatBody app={app} chat={app.lobby} channel={channel} compact />
          {info?.side && <ChatInfo key={channel.room} app={app} chat={app.lobby} channel={channel} onClose={() => setInfo(null)} />}
        </aside>
      )}

      {!home && !isVoice && showMembers && (
        <aside className="members glass">
          <div className="members-head">
            <b>{t('Участники')}</b>
            <span>
              {app.server.name}
              {app.membersReady && ` · ${plural(app.members.length, 'участник', 'участника', 'участников')}`}
            </span>
          </div>
          <div className="sidebar-scroll">
            {online.length > 0 && <div className="section-title overline">{t('В сети: ')}{online.length}</div>}
            {online.map((m) => (
              <MemberRow
                key={m.username}
                name={m.username}
                me={m.username === app.name}
                status={m.status}
                sub={app.voiceUsers.some((v) => v.identity === m.username) ? t('В голосовом · {0}', { 0: voiceName }) : presenceLine(m.status, m.lastSeen)}
                onClick={openCard(m.username)}
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
                onClick={openCard(m.username)}
              />
            ))}
          </div>
        </aside>
      )}

      {card && (
        <MemberCard
          name={card.name}
          me={card.name === app.name}
          at={{ x: card.x, y: card.y }}
          status={app.statusOf(card.name)}
          activity={app.voiceUsers.some((v) => v.identity === card.name) ? t('В голосовом · {0}', { 0: voiceName }) : presenceLine(app.statusOf(card.name), app.lastSeenOf(card.name))}
          serverName={app.server.name}
          since={cardMember?.joinedAt ? new Date(cardMember.joinedAt) : new Date()}
          onClose={() => setCard(null)}
          onProfile={() => {
            const mine = card.name === app.name;
            setCard(null);
            if (mine) setOverlay({ kind: 'user', section: 'account-edit' });
            else openProfile(card.name);
          }}
        />
      )}
    </div>
  );
}
