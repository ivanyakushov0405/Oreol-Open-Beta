import { useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { AppState } from '../../app/useAppState';
import { api, ApiError, type Me } from '../../shared/api';
import { Icon, StrikeIcon } from '../../shared/icons';
import { handleOf } from '../../shared/model';
import { Avatar, Banner } from '../../shared/ui/Avatar';
import { STATUS_ITEMS } from '../account/AccountMenu';
import { pressIcon } from './SettingsScreen';
import { t } from '../../shared/i18n';

function maskEmail(email: string) {
  const [user, domain] = email.split('@');
  return `${user?.[0] ?? ''}•••••@${domain ?? ''}`;
}

function formatPhone(phone: string | null | undefined) {
  if (!phone) return '';
  return phoneInput(phone);
}

function phoneInput(raw: string) {
  let d = raw.replace(/\D/g, '').slice(0, 15);
  if (!d) return '';
  if (d[0] === '8') d = '7' + d.slice(1);
  if (d[0] !== '7') return '+' + d;
  const p = d.slice(1, 11);
  let out = '+7';
  if (p.length) out += ' (' + p.slice(0, 3);
  if (p.length > 3) out += ') ' + p.slice(3, 6);
  if (p.length > 6) out += '-' + p.slice(6, 8);
  if (p.length > 8) out += '-' + p.slice(8, 10);
  return out;
}

function errText(e: unknown, fallback: string) {
  return e instanceof Error && e.message ? e.message : fallback;
}

/** Dialog over settings: Escape closes only the dialog, not the whole settings screen. */
function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return createPortal(
    <div
      className="dialog-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>,
    document.body,
  );
}

function PasswordDialog({ app, onClose }: { app: AppState; onClose: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (next.length < 8) return setErrs({ password: t('Минимум 8 символов') });
    if (next !== repeat) return setErrs({ repeat: t('Пароли не совпадают') });
    setBusy(true);
    setErrs({});
    try {
      await api('/api/account/password', { method: 'POST', body: { current, password: next } });
      app.notify(t('Пароль изменён. Другие сессии завершены'), 'success');
      onClose();
    } catch (err) {
      setErrs(err instanceof ApiError && Object.keys(err.fields).length ? err.fields : { _: errText(err, t('Не удалось сменить пароль')) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={t('Сменить пароль')} onClose={onClose}>
      <form className="dialog-form" onSubmit={submit}>
        <AccField label={t('Текущий пароль')} error={errs.current}>
          <PasswordInput autoComplete="current-password" autoFocus value={current} onChange={setCurrent} />
        </AccField>
        <AccField label={t('Новый пароль')} error={errs.password}>
          <PasswordInput value={next} onChange={setNext} />
        </AccField>
        <AccField label={t('Повторите новый пароль')} error={errs.repeat}>
          <PasswordInput value={repeat} onChange={setRepeat} />
        </AccField>
        {errs._ && <p className="field-hint error">{errs._}</p>}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            {t('Отмена')}
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !current || !next}>
            {busy ? t('Сохраняем…') : t('Сменить пароль')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function PasswordInput({
  value,
  onChange,
  autoComplete = 'new-password',
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  autoComplete?: string;
  autoFocus?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <span className="pw-wrap">
      <input
        className="input"
        type={show ? 'text' : 'password'}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        className="pw-eye"
        title={show ? t('Скрыть пароль') : t('Показать пароль')}
        aria-label={show ? t('Скрыть пароль') : t('Показать пароль')}
        aria-pressed={show}
        onClick={(e) => {
          e.preventDefault();
          setShow((x) => !x);
        }}
      >
        <StrikeIcon name="eye" off={show} size={18} />
      </button>
    </span>
  );
}

function DeleteDialog({ app, onClose }: { app: AppState; onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api('/api/account', { method: 'DELETE', body: { password } });
      app.logout();
    } catch (er) {
      setErr(errText(er, t('Не удалось удалить аккаунт')));
      setBusy(false);
    }
  };
  return (
    <Dialog title={t('Удалить аккаунт?')} onClose={onClose}>
      <form className="dialog-form" onSubmit={submit}>
        <p className="hint" style={{ margin: 0 }}>
          {t('Аккаунт будет удалён без возможности восстановления. Для подтверждения введите пароль.')}
        </p>
        <AccField label={t('Пароль')} error={err ?? undefined}>
          <PasswordInput autoComplete="new-password" autoFocus value={password} onChange={setPassword} />
        </AccField>
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            {t('Отмена')}
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !password}>
            <Icon name="trash" size={16} />
            {busy ? t('Удаляем…') : t('Удалить навсегда')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function AccField({ label, error, children }: { label: string; error?: string; children: ReactNode }) {
  return (
    <label className="acc-input">
      <span className="field-label">{label}</span>
      {children}
      {error && <span className="field-hint error">{error}</span>}
    </label>
  );
}

function StatusPicker({ app }: { app: AppState }) {
  return (
    <div className="status-picker" role="radiogroup" aria-label={t('Статус')}>
      {STATUS_ITEMS.map((s) => (
        <button
          key={s.id}
          type="button"
          role="radio"
          aria-checked={app.status === s.id}
          className={'status-chip' + (app.status === s.id ? ' on' : '')}
          onClick={(e) => {
            pressIcon(e.currentTarget);
            app.setStatus(s.id);
          }}
        >
          <i className={`acct-dot status-${s.id}`} />
          {s.label}
        </button>
      ))}
    </div>
  );
}

function AccountHead({
  app,
  children,
  onAvatar,
  onBanner,
  hideName,
}: {
  app: AppState;
  children: ReactNode;
  onAvatar?: () => void;
  onBanner?: () => void;
  hideName?: boolean;
}) {
  return (
    <div className="card profile-card account-head">
      {onBanner ? (
        <button type="button" className="banner-edit" title={t('Сменить баннер')} onClick={onBanner}>
          <Banner name={app.name} />
        </button>
      ) : (
        <Banner name={app.name} />
      )}
      {onAvatar ? (
        <button type="button" className="avatar-edit" title={t('Сменить аватар')} onClick={onAvatar}>
          <Avatar name={app.name} size={80} status={app.status} />
        </button>
      ) : (
        <Avatar name={app.name} size={80} status={app.status} />
      )}
      {!hideName && (
        <>
          <h2>{app.me.displayName}</h2>
        </>
      )}
      {children}
    </div>
  );
}

function useImages(app: AppState) {
  const [busy, setBusy] = useState<'avatar' | 'banner' | null>(null);
  const avatarInput = useRef<HTMLInputElement>(null);
  const bannerInput = useRef<HTMLInputElement>(null);
  const image = async (kind: 'avatar' | 'banner', file?: File) => {
    setBusy(kind);
    try {
      const r = await api<{ user: Me }>(`/api/profile/${kind}`, file ? { method: 'PUT', body: file } : { method: 'DELETE' });
      app.updateMe(r.user);
    } catch (e) {
      app.notify(errText(e, t('Не удалось обновить изображение')), 'error');
    } finally {
      setBusy(null);
    }
  };
  const input = (kind: 'avatar' | 'banner', ref: React.RefObject<HTMLInputElement>) => (
    <input
      ref={ref}
      type="file"
      accept="image/png,image/jpeg,image/webp,image/gif"
      hidden
      onChange={(e) => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (f) void image(kind, f);
      }}
    />
  );
  return {
    busy,
    pick: (kind: 'avatar' | 'banner') => (kind === 'avatar' ? avatarInput : bannerInput).current?.click(),
    remove: (kind: 'avatar' | 'banner') => void image(kind),
    inputs: (
      <>
        {input('avatar', avatarInput)}
        {input('banner', bannerInput)}
      </>
    ),
  };
}

const MAX_BIO = 190;

export function AccountView({ app, onEdit }: { app: AppState; onEdit: () => void }) {
  const [showEmail, setShowEmail] = useState(false);
  const [pw, setPw] = useState(false);
  const [del, setDel] = useState(false);
  const me = app.me;
  return (
    <>
      <AccountHead app={app}>
        <StatusPicker app={app} />
        <div className="acc-list acc-head-list">
          <div className="acc-field">
            <div className="overline">{t('О себе')}</div>
            <div className={'v' + (me.bio ? ' bio' : ' muted')}>{me.bio || t('Не заполнено')}</div>
          </div>
        </div>
      </AccountHead>
      <div className="card acc-card">
        <h3>{t('Данные аккаунта')}</h3>
        <div className="acc-list">
          <div className="acc-field">
            <div className="overline">{t('Имя пользователя')}</div>
            <div className="v">{handleOf(me.username)}</div>
          </div>
          <div className="acc-row">
            <div className="acc-field">
              <div className="overline">Email</div>
              <div className="v">{showEmail ? me.email : maskEmail(me.email)}</div>
            </div>
            <button type="button" className="btn btn-secondary btn-xs" onClick={() => setShowEmail((x) => !x)}>
              {showEmail ? t('Скрыть') : t('Показать')}
            </button>
          </div>
          <div className="acc-field">
            <div className="overline">{t('Телефон')}</div>
            <div className="v">{formatPhone(me.phone) || t('Не добавлен')}</div>
          </div>
        </div>
      </div>
      <div className="acc-actions-end">
        <button type="button" className="btn btn-primary acc-edit-btn" onClick={onEdit}>
          <Icon name="pencil" size={16} />
          {t('Редактировать')}
        </button>
      </div>
      <div className="card account-security">
        <h3>{t('Пароль и безопасность')}</h3>
        <div className="acc-actions">
          <button type="button" className="btn btn-primary" onClick={() => setPw(true)}>
            {t('Сменить пароль')}
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => app.notify(t('Двухфакторная аутентификация скоро будет'))}>
            {t('Включить 2FA')}
          </button>
        </div>
      </div>
      <div className="card danger-card">
        <div className="grow">
          <b>{t('Удаление аккаунта')}</b>
          <p>{t('Аккаунт и все данные будут удалены без возможности восстановления.')}</p>
        </div>
        <button type="button" className="btn btn-danger-solid" onClick={() => setDel(true)}>
          <Icon name="trash" size={16} />
          {t('Удалить аккаунт')}
        </button>
      </div>
      {pw && <PasswordDialog app={app} onClose={() => setPw(false)} />}
      {del && <DeleteDialog app={app} onClose={() => setDel(false)} />}
    </>
  );
}

export function AccountEdit({ app, onDone }: { app: AppState; onDone: () => void }) {
  const me = app.me;
  const initial = { username: me.username, email: me.email, phone: formatPhone(me.phone), displayName: me.displayName, bio: me.bio };
  const [form, setForm] = useState(initial);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const img = useImages(app);
  const set = (k: keyof typeof initial) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: k === 'phone' ? phoneInput(e.target.value) : e.target.value }));
  const changed = (k: keyof typeof initial) => form[k].trim() !== initial[k];
  const accDirty = (['username', 'email', 'phone', 'displayName'] as const).some(changed);
  const bioDirty = changed('bio');
  const dirty = accDirty || bioDirty;

  const save = async () => {
    setSaving(true);
    setErrs({});
    try {
      if (accDirty) {
        const r = await api<{ user: Me }>('/api/account', {
          method: 'PATCH',
          body: { displayName: form.displayName, username: form.username, email: form.email, phone: form.phone },
        });
        app.updateMe(r.user);
      }
      if (bioDirty) {
        const r = await api<{ user: Me }>('/api/profile', { method: 'PATCH', body: { bio: form.bio.trim() } });
        app.updateMe(r.user);
      }
      app.notify(t('Изменения сохранены'), 'success');
      onDone();
    } catch (e) {
      setErrs(e instanceof ApiError && Object.keys(e.fields).length ? e.fields : { _: errText(e, t('Не удалось сохранить')) });
    } finally {
      setSaving(false);
    }
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (dirty && !saving) void save();
  };

  return (
    <>
      <AccountHead app={app} hideName>
        {img.inputs}
        <StatusPicker app={app} />
        <div className="acc-photo-actions">
          <button type="button" className="btn btn-secondary btn-xs" disabled={img.busy !== null} onClick={() => img.pick('avatar')}>
            {img.busy === 'avatar' ? t('Загрузка…') : me.avatar ? t('Сменить аватар') : t('Загрузить аватар')}
          </button>
          <button type="button" className="btn btn-secondary btn-xs" disabled={img.busy !== null} onClick={() => img.pick('banner')}>
            {img.busy === 'banner' ? t('Загрузка…') : me.banner ? t('Сменить баннер') : t('Загрузить баннер')}
          </button>
          {me.avatar && (
            <button type="button" className="btn btn-secondary btn-xs" disabled={img.busy !== null} onClick={() => img.remove('avatar')}>
              {t('Убрать аватар')}
            </button>
          )}
          {me.banner && (
            <button type="button" className="btn btn-secondary btn-xs" disabled={img.busy !== null} onClick={() => img.remove('banner')}>
              {t('Убрать баннер')}
            </button>
          )}
        </div>
      </AccountHead>

      <form className="card acc-card" onSubmit={submit}>
        <h3>{t('Данные профиля')}</h3>
        <div className="acc-list">
          <AccField label={t('Отображаемое имя')} error={errs.displayName}>
            <input className="input" value={form.displayName} maxLength={32} onChange={set('displayName')} />
          </AccField>
          <label className="acc-input">
            <span className="field-label">{t('О себе')}</span>
            <textarea
              className="input textarea"
              rows={3}
              value={form.bio}
              maxLength={MAX_BIO}
              placeholder={t('Пара слов о себе для карточки участника')}
              onChange={set('bio')}
            />
            <span className="field-hint">
              {form.bio.length}/{MAX_BIO}
            </span>
          </label>
        </div>
        <button type="submit" hidden />
      </form>

      <form className="card acc-card" onSubmit={submit}>
        <h3>{t('Данные аккаунта')}</h3>
        <div className="acc-list">
          <AccField label={t('Имя пользователя')} error={errs.username}>
            <span className="input-at">
              <span className="at" aria-hidden="true">@</span>
              <input className="input" value={form.username} maxLength={32} autoComplete="username" onChange={(e) => setForm((f) => ({ ...f, username: e.target.value.replace(/^@+/, '') }))} />
            </span>
          </AccField>
          <AccField label="Email" error={errs.email}>
            <input className="input" type="email" value={form.email} autoComplete="email" onChange={set('email')} />
          </AccField>
          <AccField label={t('Телефон')} error={errs.phone}>
            <input className="input" type="tel" value={form.phone} placeholder="+7 (___) ___-__-__" autoComplete="tel" onChange={set('phone')} />
          </AccField>
        </div>
        {errs._ && <p className="field-hint error">{errs._}</p>}
        <button type="submit" hidden />
      </form>

      <div className="acc-actions-end">
        <button type="button" className="btn btn-secondary" onClick={onDone}>
          {t('Отмена')}
        </button>
        <button type="button" className="btn btn-primary" disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? t('Сохраняем…') : t('Сохранить')}
        </button>
      </div>
    </>
  );
}
