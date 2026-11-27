import type { AppState } from '../../app/useAppState';
import { Icon } from '../../shared/icons';
import type { Channel } from '../../shared/model';
import { justArrived, UnreadBadge, unreadCount, unreadMentions } from '../chat/unread';
import { VoiceUserRow } from '../voice/VoiceUserRow';
import { usePeerAnim } from '../voice/peerAnim';
import { t } from '../../shared/i18n';
import { useMuted } from '../notifications/mute';

function MutedMark({ room }: { room: string }) {
  if (!useMuted(room)) return null;
  return (
    <span className="ch-muted" title={t('Уведомления выключены')} aria-label={t('Уведомления выключены')}>
      <Icon name="speaker-off" size={18} />
    </span>
  );
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
  // Animate only when someone else joins or leaves; on our own join/leave the list switches source and must not jump.
  const voiceRows = usePeerAnim(app.voiceUsers, (p) => p.identity, `${app.server.id}:${app.voiceSource}`, 1500);
  const badge = (c: Channel, i: number) => {
    const chat = c.kind === 'voice' ? app.lobby : i === 0 ? app.general : null;
    if (!chat || active === c.id) return null;
    const n = unreadCount(chat.messages, chat.myRead, app.name);
    if (!n) return null;
    const at = unreadMentions(chat.messages, chat.myRead, app.name);
    return (
      <span className="ch-badges">
        {at > 0 && (
          <span key={'@' + at} className={'badge unread-badge mention-badge' + (justArrived([chat.room]) ? '' : ' still')} title={t('Упоминаний: {0}', { 0: at })}>
            @
          </span>
        )}
        <UnreadBadge n={n} rooms={[chat.room]} />
      </span>
    );
  };
  return (
    <>
      <div className="section-title overline">{t('Текстовые каналы')}</div>
      {text.map((c) => (
        <button
          key={c.id}
          className={'channel' + (active === c.id ? ' on' : '')}
          onClick={() => onOpen(c)}
        >
          <Icon name="chats" size={18} />
          <span className="name">{c.name}</span>
          <MutedMark room={c.room} />
          {badge(c, text.indexOf(c))}
        </button>
      ))}
      <div className="section-title overline">{t('Голосовые каналы')}</div>
      {voice.map((c) => (
        <div key={c.id}>
          <button
            className={'channel' + (active === c.id ? ' on' : '') + (app.voiceUsers.length ? ' live' : '') + (app.inVoiceHere ? ' mine' : '')}
            onClick={() => onOpen(c)}
          >
            <Icon name="voice" size={18} />
            <span className="name">{c.name}</span>
            <MutedMark room={c.room} />
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
