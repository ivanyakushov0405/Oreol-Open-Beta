import type { IconName } from '../../shared/icons';
import { t } from '../../shared/i18n';

export type UserSection = 'account' | 'account-edit' | 'profile' | 'privacy' | 'notifications' | 'voice' | 'appearance' | 'blocked';
export type ServerSection = 'overview' | 'channels' | 'roles' | 'members' | 'invites' | 'audit' | 'moderation';

export const isUserSection = (s: string | undefined): s is UserSection =>
  !!s && ['account', 'account-edit', 'profile', 'privacy', 'notifications', 'voice', 'appearance', 'blocked'].includes(s);
export const isServerSection = (s: string | undefined): s is ServerSection =>
  !!s && ['overview', 'channels', 'roles', 'members', 'invites', 'audit', 'moderation'].includes(s);

export const USER_NAV: { id: UserSection; label: string; icon: IconName; group?: string }[] = [
  { id: 'account', label: t('Учётная запись'), icon: 'user' },
  { id: 'privacy', label: t('Конфиденциальность'), icon: 'shield' },
  { id: 'notifications', label: t('Уведомления'), icon: 'bell' },
  { id: 'voice', label: t('Голос и звук'), icon: 'mic', group: t('Приложение') },
  { id: 'appearance', label: t('Внешний вид'), icon: 'appearance' },
  { id: 'blocked', label: t('Заблокированные'), icon: 'block' },
];

export function userSectionTitle(s: UserSection) {
  return s === 'account-edit' ? t('Редактирование') : USER_NAV.find((n) => n.id === userNavOf(s))!.label;
}

export function userNavOf(s: UserSection): UserSection {
  return s === 'account-edit' || s === 'profile' ? 'account' : s;
}

export const SERVER_NAV: { id: ServerSection; label: string; icon: IconName; group?: string }[] = [
  { id: 'overview', label: t('Обзор'), icon: 'settings' },
  { id: 'channels', label: t('Каналы'), icon: 'chats' },
  { id: 'roles', label: t('Роли'), icon: 'pin' },
  { id: 'members', label: t('Участники'), icon: 'users' },
  { id: 'invites', label: t('Приглашения'), icon: 'plus' },
  { id: 'audit', label: t('Журнал аудита'), icon: 'search', group: t('Модерация') },
  { id: 'moderation', label: t('Модерация'), icon: 'bell' },
];
