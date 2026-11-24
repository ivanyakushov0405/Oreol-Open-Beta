import type { IconName } from '../../shared/icons';
import { t } from '../../shared/i18n';

export type UserSection = 'account' | 'account-edit' | 'profile' | 'privacy' | 'notifications' | 'voice' | 'appearance' | 'language' | 'blocked';
export type ServerSection = 'overview' | 'channels' | 'roles' | 'members' | 'invites' | 'audit' | 'moderation';

export const isUserSection = (s: string | undefined): s is UserSection =>
  !!s && ['account', 'account-edit', 'profile', 'privacy', 'notifications', 'voice', 'appearance', 'language', 'blocked'].includes(s);
export const isServerSection = (s: string | undefined): s is ServerSection =>
  !!s && ['overview', 'channels', 'roles', 'members', 'invites', 'audit', 'moderation'].includes(s);

export const USER_NAV: { id: UserSection; label: string; icon: IconName; group?: string }[] = [
  { id: 'account', get label() { return t('Учётная запись'); }, icon: 'user' },
  { id: 'privacy', get label() { return t('Конфиденциальность'); }, icon: 'shield' },
  { id: 'notifications', get label() { return t('Уведомления'); }, icon: 'bell' },
  { id: 'voice', get label() { return t('Голос и звук'); }, icon: 'mic', get group() { return t('Приложение'); } },
  { id: 'appearance', get label() { return t('Внешний вид'); }, icon: 'appearance' },
  { id: 'language', get label() { return t('Язык'); }, icon: 'globe' },
  { id: 'blocked', get label() { return t('Заблокированные'); }, icon: 'block' },
];

export function userSectionTitle(s: UserSection) {
  return s === 'account-edit' ? t('Редактирование') : USER_NAV.find((n) => n.id === userNavOf(s))!.label;
}

export function userNavOf(s: UserSection): UserSection {
  return s === 'account-edit' || s === 'profile' ? 'account' : s;
}

export const SERVER_NAV: { id: ServerSection; label: string; icon: IconName; group?: string }[] = [
  { id: 'overview', get label() { return t('Обзор'); }, icon: 'settings' },
  { id: 'channels', get label() { return t('Каналы'); }, icon: 'chats' },
  { id: 'roles', get label() { return t('Роли'); }, icon: 'pin' },
  { id: 'members', get label() { return t('Участники'); }, icon: 'users' },
  { id: 'invites', get label() { return t('Приглашения'); }, icon: 'plus' },
  { id: 'audit', get label() { return t('Журнал аудита'); }, icon: 'search', get group() { return t('Модерация'); } },
  { id: 'moderation', get label() { return t('Модерация'); }, icon: 'bell' },
];
