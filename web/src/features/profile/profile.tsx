import { presenceLine } from '../account/status';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { paths } from '../../app/router';
import type { AppState } from '../../app/useAppState';
import { api, useUser, type Member } from '../../shared/api';
import { Icon } from '../../shared/icons';
import { handleOf, nameColor, type Server } from '../../shared/model';
import { Avatar, Banner } from '../../shared/ui/Avatar';
import { MENTION_EVENT } from '../chat/mentions';
import { ZoomAvatar } from '../chat/Photos';
import { openUserMenu } from '../members/userMenu';

import { dateFormat, t } from '../../shared/i18n';

// The collapsed row shows a few icons and a +N counter for the rest.
const SHARED_ICONS = 3;

let state: string | null = null;
const subs = new Set<() => void>();
const set = (v: string | null) => {
  state = v;
  subs.forEach((f) => f());
};
let opener: ((name: string) => void) | null = null;
export const setProfileOpener = (f: ((name: string) => void) | null) => {
  opener = f;
};
let fromChat = false;
export const profileFromChat = () => fromChat;
export const openProfile = (name: string, opts?: { inChat?: boolean }) => {
  fromChat = !!opts?.inChat;
  if (opener) opener(name);
  else set(name);
};
export const EDIT_PROFILE_EVENT = 'oreol:edit-profile';

const dateFmt = dateFormat({ day: 'numeric', month: 'long', year: 'numeric' });
const fmt = (iso: string | null | undefined) => (iso ? dateFmt.format(new Date(iso)).replace(t(' г.'), '') : null);

export function ProfileHost({ app }: { app: AppState }) {
  const name = useSyncExternalStore(
    (f) => (subs.add(f), () => void subs.delete(f)),
    () => state,
  );
  if (!name) return null;
  return <ProfileModal key={name} app={app} name={name} onClose={() => set(null)} />;
}

const membersCache = new Map<string, { at: number; list: Promise<Member[]> }>();
function serverMembers(id: string) {
  const hit = membersCache.get(id);
  if (hit && Date.now() - hit.at < 30_000) return hit.list;
  const list = api<{ members: Member[] }>(`/api/servers/${encodeURIComponent(id)}/members`).then((r) => r.members);
  list.catch(() => membersCache.delete(id));
  membersCache.set(id, { at: Date.now(), list });
  return list;
}
type Shared = { server: Server };
function useSharedServers(servers: Server[], name: string) {
  const [list, setList] = useState<Shared[] | null>(null);
  useEffect(() => {
    let off = false;
    Promise.all(
      servers.map((server) =>
        serverMembers(server.id)
          .then((ms) => {
            const m = ms.find((x) => x.username === name);
            return m ? { server } : null;
          })
          .catch(() => null),
      ),
    ).then((r) => !off && setList(r.filter((x): x is Shared => x !== null)));
    return () => {
      off = true;
    };
  }, [servers, name]);
  return list;
}

function goServer(server: Server) {
  const mobile = !!document.querySelector('.m-app');
  const ch = server.channels.find((c) => c.kind === 'text') ?? server.channels[0];
  const to = !mobile && ch ? paths.channel(server.id, ch.id) : paths.server(server.id);
  if (location.pathname !== to) history.pushState({ prev: location.pathname }, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function ProfileDetails({ app, name, onClose }: { app: AppState; name: string; onClose: () => void }) {
  const profile = useUser(name);
  const me = name === app.name;
  const display = profile?.displayName || name;
  const status = app.statusOf(name);
  const inVoice = app.voiceUsers.some((v) => v.identity === name);
  const activity = inVoice ? t('В голосовом · {0}', { 0: app.voiceChannel?.name ?? t('Голосовой') }) : presenceLine(status, app.lastSeenOf(name));
  const created = fmt(profile?.createdAt);
  const later = (what: string) => () => app.notify(t('{0} скоро будут', { 0: what }));
  const shared = useSharedServers(app.servers, name);
  const [sharedOpen, setSharedOpen] = useState(false);
  const open = (server: Server) => {
    onClose();
    goServer(server);
  };
  return (
    <div className="pm-body">
      <ZoomAvatar className="pm-avatar" url={profile?.avatar}>
        <Avatar name={name} size={96} />
      </ZoomAvatar>
      <div className="pm-identity">
        <h2 style={{ color: nameColor(name) }}>{display}</h2>
        <span className="mc-activity">
          <i className={`status-${status}`} />
          {activity}
        </span>
      </div>
      <div className="pm-actions">
        {me ? (
          <button
            type="button"
            className="mc-btn primary"
            onClick={() => {
              onClose();
              window.dispatchEvent(new Event(EDIT_PROFILE_EVENT));
            }}
          >
            <Icon name="pencil" size={20} />
            {t('Редактировать')}
          </button>
        ) : (
          <>
            <button type="button" className="mc-btn primary" onClick={later(t('Личные сообщения'))}>
              <Icon name="chats" size={24} />
              {t('Написать')}
            </button>
            <button type="button" className="mc-btn" onClick={later(t('Личные звонки'))}>
              <Icon name="phone" size={24} />
              {t('Позвонить')}
            </button>
            <button
              type="button"
              className="mc-btn"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                openUserMenu(name, r.left, r.bottom + 6, true, profileFromChat());
              }}
            >
              <Icon name="more" size={24} />
              {t('Ещё')}
            </button>
          </>
        )}
      </div>

      <div className="mc-info">
        <section>
          <div className="mc-over">{t('Имя пользователя')}</div>
          <div className="mc-value">{handleOf(name)}</div>
        </section>
        {profile?.bio && (
          <section>
            <div className="mc-over">{t('О себе')}</div>
            <p className="mc-bio">{profile.bio}</p>
          </section>
        )}
        {created && (
          <section>
            <div className="mc-over">{t('В Ореоле с')}</div>
            <div className="mc-value muted">{created}</div>
          </section>
        )}
      </div>

      <div className="mc-info">
        <section className={'pm-shared-wrap' + (sharedOpen ? ' open' : '')}>
          <button
            type="button"
            className="pm-shared"
            aria-expanded={sharedOpen}
            disabled={!shared?.length}
            onClick={() => setSharedOpen((x) => !x)}
          >
            <span className="mc-over">
              {me ? t('Серверы: ') : t('Общие серверы: ')}
              {shared ? shared.length : '…'}
            </span>
            <span className="pm-shared-icons">
              {shared?.slice(0, SHARED_ICONS).map(({ server }, i, list) => (
                <span
                  key={server.id}
                  className="mc-server-ico sm"
                  style={{ background: server.gradient, '--i': list.length - 1 - i + (shared.length > SHARED_ICONS ? 1 : 0) } as React.CSSProperties}
                >
                  {server.short}
                </span>
              ))}
              {shared && shared.length > SHARED_ICONS && (
                <span className="mc-server-ico sm pm-shared-more" style={{ '--i': 0 } as React.CSSProperties}>
                  +{shared.length - SHARED_ICONS}
                </span>
              )}
              {!!shared?.length && <Icon name="chevron-down" size={16} />}
            </span>
          </button>
          <div className="pm-shared-list">
            <div>
              {shared?.map(({ server }) => (
                <div key={server.id} className="pm-server">
                  <button
                    type="button"
                    className="mc-server-ico pm-server-go"
                    style={{ background: server.gradient }}
                    aria-hidden="true"
                    tabIndex={-1}
                    onClick={() => open(server)}
                  >
                    {server.short}
                  </button>
                  <div className="pm-server-body">
                    <button type="button" className="pm-server-name" tabIndex={sharedOpen ? 0 : -1} onClick={() => open(server)}>
                      {server.name}
                    </button>
                    <span className="pm-server-nick">{display}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function ProfileModal({ app, name, onClose }: { app: AppState; name: string; onClose: () => void }) {
  const profile = useUser(name);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    window.addEventListener(MENTION_EVENT, onClose);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(MENTION_EVENT, onClose);
    };
  }, [onClose]);

  return createPortal(
    <div className="dialog-backdrop profile-backdrop" onClick={onClose}>
      <div className="profile-modal" role="dialog" aria-label={t('Профиль {0}', { 0: profile?.displayName || name })} onClick={(e) => e.stopPropagation()}>
        <button type="button" className="pm-close" aria-label={t('Закрыть')} onClick={onClose}>
          <Icon name="close" size={18} />
        </button>
        <Banner name={name} />
        <ProfileDetails app={app} name={name} onClose={onClose} />
      </div>
    </div>,
    document.body,
  );
}
