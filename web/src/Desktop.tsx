import { openProfile, EDIT_PROFILE_EVENT } from './profile';
import { useEffect, useRef, useState } from 'react';
import type { AppState } from './App';
import { Icon } from './icons';
import { handleOf, type Channel, type ServerId, type Status } from './mock';
import {
  SERVER_NAV,
  isServerSection,
  isUserSection,
  USER_NAV,
  ServerSettingsBody,
  SettingsScreen,
  UserSettingsBody,
  userNavOf,
  userSectionTitle,
  type ServerSection,
  type UserSection,
} from './Settings';
import { MemberCard, MemberRow, TypingLine } from './ui';
import { parseRoute, paths, useUrlSync } from './router';
import { ChannelList, ChatBody, Rail, UserPanel, VoiceStage, VoiceStatus, useElapsed, PinnedButton, UnreadBadge, chatUnread } from './views';

type Overlay = { kind: 'user'; section: UserSection } | { kind: 'server'; section: ServerSection } | null;

function plural(n: number, one: string, few: string, many: string) {
  const m10 = n % 10, m100 = n % 100;
  const w = m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  return `${n} ${w}`;
}

/** Подпись статуса для карточки участника. */
export const STATUS_LABEL: Record<Status, string> = { online: 'В сети', idle: 'Не активен', dnd: 'Не беспокоить', offline: 'Не в сети' };

export function Desktop({ app }: { app: AppState }) {
  const [home, setHome] = useState(false);
  const [channelId, setChannelId] = useState<string | null>(null);
  const channel = app.server.channels.find((c) => c.id === channelId) ?? app.server.channels[0];
  const [showMembers, setShowMembers] = useState(true);
  const [voiceChat, setVoiceChat] = useState(false);
  const [overlay, setOverlay] = useState<Overlay>(null);
  /** Закрытие настроек: сначала анимация ухода окна, потом основной экран (он проявляется — класс from-settings). */
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
  // «Редактировать профиль» из окна полного профиля
  useEffect(() => {
    const edit = () => setOverlay({ kind: 'user', section: 'account-edit' });
    window.addEventListener(EDIT_PROFILE_EVENT, edit);
    return () => window.removeEventListener(EDIT_PROFILE_EVENT, edit);
  }, []);
  const [card, setCard] = useState<{ name: string; x: number; y: number } | null>(null);

  /** Время в голосовом — хук стоит до любых return, иначе React падает при открытии настроек. */
  const elapsed = useElapsed(app.inVoiceHere ? app.voice.startedAt : null);
  useEffect(() => {
    if (!overlay) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeOverlay();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [overlay]);

  // Адрес ↔ состояние: сервер, канал, чат войса, настройки
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
        overline="Настройки пользователя"
        nav={USER_NAV}
        section={overlay.section}
        active={userNavOf(overlay.section)}
        onSection={(s) => setOverlay({ kind: 'user', section: s })}
        onClose={closeOverlay}
        closing={closing}
        footer={
          <button className="nav-item danger" onClick={app.logout}>
            <Icon name="logout" size={18} />
            Выйти
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
          <button className="nav-item danger" onClick={() => app.notify('Удаление сервера недоступно в демо')}>
            <Icon name="trash" size={18} />
            Удалить сервер
          </button>
        }
      >
        <ServerSettingsBody app={app} section={overlay.section} />
      </SettingsScreen>
    );
  }

  const openSettings = () => setOverlay({ kind: 'user', section: 'account' });
  // Клик по голосовому каналу сразу подключает к нему.
  const openChannel = (c: Channel) => {
    setChannelId(c.id);
    if (c.kind === 'voice') app.joinVoice();
  };
  const isVoice = channel.kind === 'voice';
  const chat = isVoice ? app.lobby : app.general;
  const online = app.membersOnline;
  const cardMember = card ? app.members.find((m) => m.username === card.name) : undefined;
  const voiceName = app.voiceChannel?.name ?? 'Голосовой';

  const openCard = (name: string) => (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setCard({ name, x: r.left - 308, y: r.top });
  };

  return (
    <div className={'app' + (app.glassChat ? ' glass-chat' : '') + (app.glassVoice ? ' glass-voice' : '') + (fromSettings ? ' from-settings' : '')}>
      <Rail app={app} home={home} onHome={() => setHome(true)} onServer={(id: ServerId) => {
          setHome(false);
          app.setServerId(id);
          // На сервер заходим в первый текстовый канал (general); если сидим в его войсе — сразу в войс
          const srv = app.serverById(id);
          const inHisVoice = app.voice.state !== 'idle' && app.voice.server === id;
          const ch = srv?.channels.find((c) => (inHisVoice ? c.kind === 'voice' : c.kind !== 'voice'));
          setChannelId(ch?.id ?? null);
          setVoiceChat(false);
        }} />

      <aside className="sidebar glass">
        {home ? (
          <>
            <div className="sidebar-head">Личные сообщения</div>
            <div className="sidebar-scroll">
              <div className="empty-state" style={{ marginTop: 40, fontSize: 13 }}>
                <b>Пока пусто</b>
                Личные сообщения — скоро будут
              </div>
            </div>
          </>
        ) : (
          <>
            <button className="sidebar-head" onClick={() => setOverlay({ kind: 'server', section: 'overview' })} title="Настройки сервера">
              <span>{app.server.name}</span>
              <Icon name="chevron-down" size={18} />
            </button>
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
            <div className="title">Личные сообщения</div>
          </div>
          <div className="chat">
            <div className="chat-scroll">
              <div className="empty-state">
                <b>Здесь будут ваши диалоги</b>
                Пока доступны только чаты серверов.
              </div>
            </div>
          </div>
        </main>
      ) : (
        <main className={'main glass' + (isVoice ? ' main-voice' : '')}>
          <div className="main-head">
            <Icon name={isVoice ? 'voice' : 'chats'} />
            <div>
              <div className="title">{channel.name}</div>
              <div className="sub">
                {isVoice ? (
                  app.inVoiceHere && app.voice.state === 'connected' ? (
                    <>
                      <i className={`live-dot q-${app.voice.quality}`} />
                      {`Подключено · ${app.voice.peers.length} в канале${elapsed ? ` · ${elapsed}` : ''}`}
                    </>
                  ) : app.inVoiceHere && app.voice.state === 'connecting' ? (
                    'Подключение…'
                  ) : (
                    'Голосовой канал'
                  )
                ) : (
                  <TypingLine users={chat.typingUsers.filter((u) => u !== app.name)} fallback={app.membersReady ? `${online.length} в сети` : ' '} />
                )}
              </div>
            </div>
            {isVoice ? (
              <div className="actions">
                <button type="button" className={'btn-chip' + (voiceChat ? ' on' : '')} onClick={() => setVoiceChat((v) => !v)}>
                  <Icon name="chats" size={16} />
                  Чат канала
                  {!voiceChat && <UnreadBadge n={chatUnread(app, app.lobby)} />}
                </button>
              </div>
            ) : (
            <div className="actions">
              <PinnedButton chat={chat} />
              <button className="icon-btn" title="Уведомления" onClick={() => app.notify('Настройка уведомлений — в демо недоступна')}>
                <Icon name="bell" />
              </button>
              <button className="icon-btn" title="Поиск" onClick={() => app.notify('Поиск — скоро будет')}>
                <Icon name="search" />
              </button>
              <button className={'icon-btn' + (showMembers ? ' active' : '')} title="Участники" onClick={() => setShowMembers((s) => !s)}>
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
        </main>
      )}

      {!home && isVoice && voiceChat && (
        <aside className="side-chat glass">
          <div className="main-head">
            <Icon name="chats" />
            <div>
              <div className="title">Чат · {voiceName}</div>
              <div className="sub">
                <TypingLine users={app.lobby.typingUsers.filter((u) => u !== app.name)} fallback="Видят участники голосового" />
              </div>
            </div>
            <div className="actions">
              <PinnedButton chat={app.lobby} />
              <button className="icon-btn" title="Закрыть чат" onClick={() => setVoiceChat(false)}>
                <Icon name="close" />
              </button>
            </div>
          </div>
          <ChatBody app={app} chat={app.lobby} channel={channel} compact />
        </aside>
      )}

      {!home && !isVoice && showMembers && (
        <aside className="members glass">
          <div className="members-head">
            <b>Участники</b>
            <span>
              {app.server.name}
              {app.membersReady && ` · ${plural(app.members.length, 'участник', 'участника', 'участников')}`}
            </span>
          </div>
          <div className="sidebar-scroll">
            {online.length > 0 && <div className="section-title overline">В сети — {online.length}</div>}
            {online.map((m) => (
              <MemberRow
                key={m.username}
                name={m.username}
                me={m.username === app.name}
                status={m.status}
                sub={app.voiceUsers.some((v) => v.identity === m.username) ? `В голосовом · ${voiceName}` : handleOf(m.username)}
                onClick={openCard(m.username)}
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
          activity={app.voiceUsers.some((v) => v.identity === card.name) ? `В голосовом · ${voiceName}` : STATUS_LABEL[app.statusOf(card.name)]}
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
