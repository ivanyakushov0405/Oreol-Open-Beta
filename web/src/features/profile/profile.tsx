import { useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { paths } from '../../app/router';
import type { AppState } from '../../app/useAppState';
import { api, useUser, type Member } from '../../shared/api';
import { Icon } from '../../shared/icons';
import { handleOf, nameColor, type Server, type Status } from '../../shared/model';
import { Avatar, Banner } from '../../shared/ui/Avatar';
import { MENTION_EVENT } from '../chat/mentions';
import { openUserMenu } from '../members/userMenu';

/* ---------- Полный профиль (Figma «Desktop · User profile (modal)»): openProfile(имя) откуда угодно ---------- */
let state: string | null = null;
const subs = new Set<() => void>();
const set = (v: string | null) => {
  state = v;
  subs.forEach((f) => f());
};
/** Телефон подменяет открытие профиля своей шторкой (та же, что из списка участников). */
let opener: ((name: string) => void) | null = null;
export const setProfileOpener = (f: ((name: string) => void) | null) => {
  opener = f;
};
/** Профиль открыт из чата (аватар, ник, упоминание в сообщении) — только тогда в «…» есть «Упомянуть»:
 *  из списка участников или войса упоминать некуда. */
let fromChat = false;
export const profileFromChat = () => fromChat;
export const openProfile = (name: string, opts?: { inChat?: boolean }) => {
  fromChat = !!opts?.inChat;
  if (opener) opener(name);
  else set(name);
};
/** Событие «открыть редактирование своего профиля» — его ловят Desktop и Mobile (у них свои настройки). */
export const EDIT_PROFILE_EVENT = 'oreol:edit-profile';

const LABEL: Record<Status, string> = { online: 'В сети', idle: 'Не активен', dnd: 'Не беспокоить', offline: 'Не в сети' };
const dateFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
const fmt = (iso: string | null | undefined) => (iso ? dateFmt.format(new Date(iso)).replace(' г.', '') : null);

export function ProfileHost({ app }: { app: AppState }) {
  const name = useSyncExternalStore(
    (f) => (subs.add(f), () => void subs.delete(f)),
    () => state,
  );
  if (!name) return null;
  return <ProfileModal key={name} app={app} name={name} onClose={() => set(null)} />;
}

/* ---------- Общие серверы: участники каждого моего сервера (кэш на 30 с), ищем среди них пользователя ---------- */
const membersCache = new Map<string, { at: number; list: Promise<Member[]> }>();
function serverMembers(id: string) {
  const hit = membersCache.get(id);
  if (hit && Date.now() - hit.at < 30_000) return hit.list;
  const list = api<{ members: Member[] }>(`/api/servers/${encodeURIComponent(id)}/members`).then((r) => r.members);
  list.catch(() => membersCache.delete(id));
  membersCache.set(id, { at: Date.now(), list });
  return list;
}
type Shared = { server: Server; joinedAt: string | null };
function useSharedServers(servers: Server[], name: string) {
  const [list, setList] = useState<Shared[] | null>(null);
  useEffect(() => {
    let off = false;
    Promise.all(
      servers.map((server) =>
        serverMembers(server.id)
          .then((ms) => {
            const m = ms.find((x) => x.username === name);
            return m ? { server, joinedAt: m.joinedAt } : null;
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

/** Перейти на сервер (в его первый текстовый канал) — через адрес, его разбирают и десктоп, и телефон. */
function goServer(server: Server) {
  // Телефон — на вкладку сервера (список каналов); десктоп — сразу в первый текстовый канал
  const mobile = !!document.querySelector('.m-app');
  const ch = server.channels.find((c) => c.kind === 'text') ?? server.channels[0];
  const to = !mobile && ch ? paths.channel(server.id, ch.id) : paths.server(server.id);
  if (location.pathname !== to) history.pushState({ prev: location.pathname }, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/** Содержимое полного профиля: окно на десктопе и развёрнутая шторка на телефоне показывают одно и то же. */
export function ProfileDetails({ app, name, onClose }: { app: AppState; name: string; onClose: () => void }) {
  const profile = useUser(name);
  const member = app.members.find((m) => m.username === name);
  const me = name === app.name;
  const status = app.statusOf(name);
  const inVoice = app.voiceUsers.some((v) => v.identity === name);
  const activity = inVoice ? `В голосовом · ${app.voiceChannel?.name ?? 'Голосовой'}` : LABEL[status];
  const since = fmt(member?.joinedAt);
  const created = fmt(profile?.createdAt);
  const later = (what: string) => () => app.notify(`${what} скоро будут`);
  const shared = useSharedServers(app.servers, name);
  const [sharedOpen, setSharedOpen] = useState(false);
  const open = (server: Server) => {
    onClose();
    goServer(server);
  };
  return (
    <div className="pm-body">
      <span className="pm-avatar">
        <Avatar name={name} size={96} status={status} />
      </span>
      <div className="pm-identity">
        <h2 style={{ color: nameColor(name) }}>{profile?.displayName || name}</h2>
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
            <Icon name="pencil" size={16} />
            Редактировать профиль
          </button>
        ) : (
          <>
            <button type="button" className="mc-btn primary" onClick={later('Личные сообщения')}>
              <Icon name="chats" size={16} />
              Написать
            </button>
            <button type="button" className="mc-btn" onClick={later('Личные звонки')}>
              <Icon name="voice" size={16} />
              Позвонить
            </button>
            {profileFromChat() && <button
              type="button"
              className="mc-btn icon"
              aria-label="Ещё"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                openUserMenu(name, r.left, r.bottom + 6, true);
              }}
            >
              <Icon name="more" size={16} />
            </button>}
          </>
        )}
      </div>

      <div className="mc-info">
        <section>
          <div className="mc-over">Имя пользователя</div>
          <div className="mc-value">{handleOf(name)}</div>
        </section>
        {profile?.bio && (
          <section>
            <div className="mc-over">Обо мне</div>
            <p className="mc-bio">{profile.bio}</p>
          </section>
        )}
        {created && (
          <section>
            <div className="mc-over">В Ореоле с</div>
            <div className="mc-value muted">{created}</div>
          </section>
        )}
      </div>

      <div className="mc-info">
        <section>
          <button type="button" className="pm-server" onClick={() => open(app.server)}>
            <span className="mc-server-ico" style={{ background: app.server.gradient }}>
              {app.server.short}
            </span>
            <span>
              <b>{app.server.name}</b>
              {since && <small>На сервере с {since}</small>}
            </span>
          </button>
          <div className="mc-roles">
            <span className="mc-role">
              <i style={{ background: 'var(--role-everyone, #5c7590)' }} />
              @everyone
            </span>
            {me && <span className="mc-role">Это вы</span>}
          </div>
        </section>
      </div>

      {!me && (
        <div className="mc-info">
          <section className={'pm-shared-wrap' + (sharedOpen ? ' open' : '')}>
            <button
              type="button"
              className="pm-shared"
              aria-expanded={sharedOpen}
              disabled={!shared?.length}
              onClick={() => setSharedOpen((x) => !x)}
            >
              <span className="mc-over">Общие серверы: {shared ? shared.length : '…'}</span>
              <span className="pm-shared-icons">
                {shared?.slice(0, 3).map(({ server }) => (
                  <span key={server.id} className="mc-server-ico sm" style={{ background: server.gradient }}>
                    {server.short}
                  </span>
                ))}
                {!!shared?.length && <Icon name="chevron-down" size={16} />}
              </span>
            </button>
            <div className="pm-shared-list">
              <div>
                {shared?.map(({ server, joinedAt }) => (
                  <button key={server.id} type="button" className="pm-server" tabIndex={sharedOpen ? 0 : -1} onClick={() => open(server)}>
                    <span className="mc-server-ico" style={{ background: server.gradient }}>
                      {server.short}
                    </span>
                    <span>
                      <b>{server.name}</b>
                      {fmt(joinedAt) && <small>На сервере с {fmt(joinedAt)}</small>}
                    </span>
                    <Icon name="chevron-right" size={18} />
                  </button>
                ))}
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function ProfileModal({ app, name, onClose }: { app: AppState; name: string; onClose: () => void }) {
  const profile = useUser(name);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    // «Упомянуть» из меню «…» — профиль закрывается, чтобы было видно поле ввода с упоминанием
    window.addEventListener(MENTION_EVENT, onClose);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(MENTION_EVENT, onClose);
    };
  }, [onClose]);

  return createPortal(
    <div className="dialog-backdrop profile-backdrop" onClick={onClose}>
      <div className="profile-modal" role="dialog" aria-label={`Профиль ${profile?.displayName || name}`} onClick={(e) => e.stopPropagation()}>
        <button type="button" className="pm-close" aria-label="Закрыть" onClick={onClose}>
          <Icon name="close" size={18} />
        </button>
        <Banner name={name} />
        <ProfileDetails app={app} name={name} onClose={onClose} />
      </div>
    </div>,
    document.body,
  );
}
