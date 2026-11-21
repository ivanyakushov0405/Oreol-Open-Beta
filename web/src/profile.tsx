import { useEffect, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Avatar, Banner } from './ui';
import { Icon } from './icons';
import { handleOf, nameColor, type Status } from './mock';
import { useUser } from './auth';
import { openUserMenu } from './userMenu';
import type { AppState } from './App';

/* ---------- Полный профиль (Figma «Desktop · User profile (modal)»): openProfile(имя) откуда угодно ---------- */
let state: string | null = null;
const subs = new Set<() => void>();
const set = (v: string | null) => {
  state = v;
  subs.forEach((f) => f());
};
export const openProfile = (name: string) => set(name);
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

function ProfileModal({ app, name, onClose }: { app: AppState; name: string; onClose: () => void }) {
  const profile = useUser(name);
  const member = app.members.find((m) => m.username === name);
  const me = name === app.name;
  const status = app.statusOf(name);
  const inVoice = app.voiceUsers.some((v) => v.identity === name);
  const activity = inVoice ? `В голосовом · ${app.voiceChannel?.name ?? 'Голосовой'}` : LABEL[status];
  const since = fmt(member?.joinedAt);
  const created = fmt(profile?.createdAt);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const later = (what: string) => () => app.notify(`${what} появятся позже`);

  return createPortal(
    <div className="dialog-backdrop profile-backdrop" onClick={onClose}>
      <div className="profile-modal" role="dialog" aria-label={`Профиль ${profile?.displayName || name}`} onClick={(e) => e.stopPropagation()}>
        <button type="button" className="pm-close" aria-label="Закрыть" onClick={onClose}>
          <Icon name="close" size={18} />
        </button>
        <Banner name={name} />
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
                <button type="button" className="mc-btn" onClick={later('Друзья')}>
                  <Icon name="user-plus" size={16} />
                  В друзья
                </button>
                <button
                  type="button"
                  className="mc-btn icon"
                  aria-label="Ещё"
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    openUserMenu(name, r.left, r.bottom + 6);
                  }}
                >
                  <Icon name="more" size={16} />
                </button>
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
              <div className="pm-server">
                <span className="mc-server-ico" style={{ background: app.server.gradient }}>
                  {app.server.short}
                </span>
                <span>
                  <b>{app.server.name}</b>
                  {since && <small>На сервере с {since}</small>}
                </span>
              </div>
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
              <section className="pm-shared">
                <div className="mc-over">Общие серверы — 1</div>
                <span className="mc-server-ico sm" style={{ background: app.server.gradient }} title={app.server.name}>
                  {app.server.short}
                </span>
              </section>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
