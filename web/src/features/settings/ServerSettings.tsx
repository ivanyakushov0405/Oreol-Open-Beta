import type { AppState } from '../../app/useAppState';
import { handleOf } from '../../shared/model';
import { Avatar } from '../../shared/ui/Avatar';
import { RolesEditor } from './RolesEditor';
import { Soon } from './UserSettings';
import type { ServerSection } from './nav';

export function ServerSettingsBody({ app, section }: { app: AppState; section: ServerSection }) {
  switch (section) {
    case 'overview':
      return (
        <div className="grid-2">
          <div className="card kv">
            <label>
              <span className="field-label">Название сервера</span>
              <input className="input" value={app.server.name} disabled />
            </label>
            <label>
              <span className="field-label">Описание</span>
              <input className="input" value={app.server.about} disabled />
            </label>
            <p className="hint" style={{ margin: 0 }}>
              Редактирование — скоро будет
            </p>
          </div>
          <div className="card profile-card">
            <div className="banner" />
            <span
              className="avatar"
              style={{ width: 72, height: 72, margin: '-36px auto 0', background: app.server.gradient, fontSize: 24 }}
            >
              {app.server.short}
            </span>
            <h2>{app.server.name}</h2>
            <div className="handle">
              {app.membersOnline.length} в сети · {app.members.length} участников
            </div>
            <div style={{ height: 20 }} />
          </div>
        </div>
      );
    case 'roles':
      return <RolesEditor app={app} />;
    case 'members':
      return (
        <div className="card">
          <h3>Участники — {app.members.length}</h3>
          <p className="hint">Все, кто состоит на сервере; {app.membersOnline.length} сейчас в сети</p>
          {app.members.map((m) => (
            <div className="list-row" key={m.username}>
              <Avatar name={m.username} size={28} status={m.status} />
              <span className="grow" style={{ color: 'var(--text-primary)' }}>
                {m.displayName}
                {m.username === app.name ? ' (вы)' : ''}
              </span>
              <span>{handleOf(m.username)}</span>
            </div>
          ))}
        </div>
      );
    case 'channels':
      return <Soon title="Каналы" text="Создание и редактирование каналов — скоро будет" />;
    case 'invites':
      return <Soon title="Приглашения" />;
    case 'audit':
      return <Soon title="Журнал аудита" />;
    case 'moderation':
      return <Soon title="Модерация" />;
  }
}

/** Полноэкранные настройки на десктопе. */
/** Анимация иконки пункта меню по нажатию: атрибут data-press перезапускает её при каждом клике
 *  (атрибут не из пропсов, поэтому React его не перезаписывает при смене className). */
