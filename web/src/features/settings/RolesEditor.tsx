import { Fragment, useState } from 'react';
import type { AppState } from '../../app/useAppState';
import { Icon } from '../../shared/icons';
import { Toggle } from './Toggle';

/* ---------- Роли (макет «Desktop · Server settings · Роли») ---------- */
const ROLE_SWATCHES = ['#00e5ff', '#ff5c7a', '#7a5cff', '#3ddc97', '#ffb840', '#548fff', '#fa78d9', '#5c7590'];
const PERMISSIONS = [
  { id: 'channels', title: 'Управлять каналами', text: 'Создавать, менять и удалять каналы' },
  { id: 'messages', title: 'Удалять сообщения', text: 'Чужие сообщения в любом канале' },
  { id: 'kick', title: 'Выгонять участников', text: 'Можно вернуться по приглашению' },
  { id: 'ban', title: 'Банить участников', text: 'Блокировка без возможности войти' },
  { id: 'everyone', title: 'Упоминать @everyone', text: 'Уведомление всем участникам' },
] as const;
type PermId = (typeof PERMISSIONS)[number]['id'];
interface RoleState {
  id: string;
  name: string;
  color: string;
  perms: Record<PermId, boolean>;
}
const allPerms = (on: boolean): Record<PermId, boolean> => ({ channels: on, messages: on, kick: on, ban: on, everyone: on });
const INITIAL_ROLES: RoleState[] = [
  { id: 'admin', name: 'Админ', color: '#ff5c7a', perms: allPerms(true) },
  { id: 'mod', name: 'Модератор', color: '#00e5ff', perms: { channels: true, messages: true, kick: true, ban: false, everyone: false } },
  { id: 'raid', name: 'Рейд-лид', color: '#7a5cff', perms: { channels: false, messages: false, kick: false, ban: false, everyone: true } },
  { id: 'healer', name: 'Хилер', color: '#3ddc97', perms: allPerms(false) },
  { id: 'everyone', name: '@everyone', color: '#5c7590', perms: allPerms(false) },
];

function RoleRow({ role, count, on, onClick }: { role: RoleState; count: string; on: boolean; onClick: () => void }) {
  return (
    <button type="button" className={'role-row' + (on ? ' on' : '')} onClick={onClick}>
      <span className="role-color">
        <i style={{ background: role.color }} />
      </span>
      <span className="role-name" style={{ color: role.color }}>
        {role.name || 'Без названия'}
      </span>
      <span className="role-count">{count}</span>
      <Icon name="chevron-right" size={18} />
    </button>
  );
}

export function RolesEditor({ app }: { app: AppState }) {
  const [roles, setRoles] = useState(INITIAL_ROLES);
  const [selected, setSelected] = useState('mod');
  const role = roles.find((r) => r.id === selected)!;
  const update = (patch: Partial<RoleState>) => setRoles((rs) => rs.map((r) => (r.id === selected ? { ...r, ...patch } : r)));
  const custom = roles.filter((r) => r.id !== 'everyone');
  const everyone = roles.find((r) => r.id === 'everyone')!;
  const locked = role.id === 'everyone';
  // Мок-участников нет: «Админ» — владелец сервера (вы), @everyone — все, кто сейчас в сети.
  const countOf = (r: RoleState) => (r.id === 'everyone' ? `все ${app.members.length}` : `${r.id === 'admin' ? 1 : 0} уч.`);

  return (
    <div className="roles-layout">
      <section className="roles-panel">
        <div className="roles-head">
          <h3>Роли: {custom.length}</h3>
          <p>Чем выше в списке, тем главнее. Перетаскивайте, чтобы изменить порядок.</p>
        </div>
        <div className="roles-list">
          {custom.map((r, i) => (
            <Fragment key={r.id}>
              {i > 0 && <div className="roles-divider" />}
              <RoleRow role={r} count={countOf(r)} on={r.id === selected} onClick={() => setSelected(r.id)} />
            </Fragment>
          ))}
        </div>
        <button type="button" className="btn-chip" onClick={() => app.notify('Создание ролей скоро будет')}>
          <Icon name="plus" size={16} />
          Создать роль
        </button>
        <div className="overline roles-overline">По умолчанию</div>
        <div className="roles-list">
          <RoleRow role={everyone} count={countOf(everyone)} on={locked} onClick={() => setSelected('everyone')} />
        </div>
      </section>

      <div className="roles-editor">
        <section className="roles-panel">
          <h3>Роль</h3>
          <label className="auth-field">
            <span className="field-label">Название роли</span>
            <input
              className="input role-input"
              style={{ color: role.color }}
              value={role.name}
              maxLength={32}
              disabled={locked}
              onChange={(e) => update({ name: e.target.value })}
            />
          </label>
          <div className="role-colors">
            <span className="field-label">Цвет</span>
            <div className="swatches">
              {ROLE_SWATCHES.map((c) => (
                <button
                  type="button"
                  key={c}
                  aria-label={'Цвет ' + c}
                  className={'swatch' + (role.color === c ? ' on' : '')}
                  style={{ background: c }}
                  disabled={locked}
                  onClick={() => update({ color: c })}
                />
              ))}
            </div>
          </div>
        </section>
        <div className="overline roles-overline">Права</div>
        <section className="perms-panel">
          {PERMISSIONS.map((p, i) => (
            <Fragment key={p.id}>
              {i > 0 && <div className="roles-divider" />}
              <div className="perm-row">
                <div className="perm-text">
                  <b>{p.title}</b>
                  <span>{p.text}</span>
                </div>
                <Toggle on={role.perms[p.id]} onChange={(v) => update({ perms: { ...role.perms, [p.id]: v } })} />
              </div>
            </Fragment>
          ))}
        </section>
      </div>
    </div>
  );
}
