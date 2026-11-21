import type { IconName } from '../../shared/icons';

export type UserSection = 'account' | 'account-edit' | 'profile' | 'privacy' | 'notifications' | 'voice' | 'appearance' | 'blocked';
export type ServerSection = 'overview' | 'channels' | 'roles' | 'members' | 'invites' | 'audit' | 'moderation';

/** Разделы из адреса (/settings/:section, /servers/:sid/settings/:section) — только известные. */
export const isUserSection = (s: string | undefined): s is UserSection =>
  !!s && ['account', 'account-edit', 'profile', 'privacy', 'notifications', 'voice', 'appearance', 'blocked'].includes(s);
export const isServerSection = (s: string | undefined): s is ServerSection =>
  !!s && ['overview', 'channels', 'roles', 'members', 'invites', 'audit', 'moderation'].includes(s);

export const USER_NAV: { id: UserSection; label: string; icon: IconName; group?: string }[] = [
  { id: 'account', label: 'Учётная запись', icon: 'user' },
  { id: 'privacy', label: 'Конфиденциальность', icon: 'shield' },
  { id: 'notifications', label: 'Уведомления', icon: 'bell' },
  { id: 'voice', label: 'Голос и звук', icon: 'mic', group: 'Приложение' },
  { id: 'appearance', label: 'Внешний вид', icon: 'appearance' },
  { id: 'blocked', label: 'Заблокированные', icon: 'block' },
];

/** Заголовок раздела. «Редактирование профиля» — подстраница «Учётной записи» (Figma). */
export function userSectionTitle(s: UserSection) {
  return s === 'account-edit' ? 'Редактирование' : USER_NAV.find((n) => n.id === userNavOf(s))!.label;
}

/** Какой пункт навигации подсветить для раздела. */
export function userNavOf(s: UserSection): UserSection {
  return s === 'account-edit' || s === 'profile' ? 'account' : s;
}

export const SERVER_NAV: { id: ServerSection; label: string; icon: IconName; group?: string }[] = [
  { id: 'overview', label: 'Обзор', icon: 'settings' },
  { id: 'channels', label: 'Каналы', icon: 'chats' },
  { id: 'roles', label: 'Роли', icon: 'pin' },
  { id: 'members', label: 'Участники', icon: 'users' },
  { id: 'invites', label: 'Приглашения', icon: 'plus' },
  { id: 'audit', label: 'Журнал аудита', icon: 'search', group: 'Модерация' },
  { id: 'moderation', label: 'Модерация', icon: 'bell' },
];
