import type { AppState } from '../../app/useAppState';
import { handleOf } from '../../shared/model';
import { Avatar } from '../../shared/ui/Avatar';
import { RolesEditor } from './RolesEditor';
import { Soon } from './UserSettings';
import type { ServerSection } from './nav';
import { t } from '../../shared/i18n';

export function ServerSettingsBody({ app, section }: { app: AppState; section: ServerSection }) {
  switch (section) {
    case 'overview':
      return (
        <div className="grid-2">
          <div className="card kv">
            <label>
              <span className="field-label">{t('Название сервера')}</span>
              <input className="input" value={app.server.name} disabled />
            </label>
            <label>
              <span className="field-label">{t('Описание')}</span>
              <input className="input" value={app.server.about} disabled />
            </label>
            <p className="hint" style={{ margin: 0 }}>
              {t('Редактирование скоро будет')}
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
              {app.membersOnline.length}{t(' в сети · ')}{app.members.length}{t(' участников')}
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
          <h3>{t('Участники: ')}{app.members.length}</h3>
          <p className="hint">{t('Все, кто состоит на сервере; ')}{app.membersOnline.length}{t(' сейчас в сети')}</p>
          {app.members.map((m) => (
            <div className="list-row" key={m.username}>
              <Avatar name={m.username} size={28} status={m.status} />
              <span className="grow" style={{ color: 'var(--text-primary)' }}>
                {m.displayName}
                {m.username === app.name ? t(' (вы)') : ''}
              </span>
              <span>{handleOf(m.username)}</span>
            </div>
          ))}
        </div>
      );
    case 'channels':
      return <Soon title={t('Каналы')} text={t('Создание и редактирование каналов скоро будет')} />;
    case 'invites':
      return <Soon title={t('Приглашения')} />;
    case 'audit':
      return <Soon title={t('Журнал аудита')} />;
    case 'moderation':
      return <Soon title={t('Модерация')} />;
  }
}

/**
 * Icon press animation: the data-press attribute restarts it on every click (React does not own the attribute,
 * so className changes do not overwrite it).
 */
