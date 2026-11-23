import { lang, t } from './i18n';

export type Status = 'online' | 'idle' | 'dnd' | 'offline';

export interface Channel {
  id: string;
  name: string;
  kind: 'text' | 'voice';
  room: string;
}

export interface Server {
  id: string;
  short: string;
  name: string;
  about: string;
  gradient: string;
  channels: Channel[];
}

export type ServerId = Server['id'];

export interface ChatMessage {
  id: string | number;
  /** Deleted message still on screen while its leave animation plays (client only). */
  leaving?: boolean;
  user: string;
  content: string;
  ts: string | null;
  edited?: string | null;
  pinned?: boolean;
  reply?: { id: number | string; user?: string; content?: string; photo?: string | null; deleted?: boolean } | null;
  fwd?: { user: string; ts: string | null } | null;
  sys?: string | null;
  replies?: number;
  attachments?: Attachment[];
  reactions?: Reaction[];
}

export interface Reaction {
  e: string;
  users: string[];
}

export const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '👎', '🤡', '🎉', '🙏'];

export interface Attachment {
  id: number;
  url: string;
  w: number;
  h: number;
  video?: boolean;
  /** A document: downloaded, never shown inline. */
  file?: boolean;
  name?: string;
  size?: number;
}

/** Photo limits; the server checks the same ones. */
export const MAX_PHOTOS = 10;
export const MAX_PHOTO_MB = 10;
export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
export const VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'];
export const MAX_VIDEO_MB = 50;
export const MAX_FILE_MB = 50;

export const isMedia = (a: Attachment) => !a.file;

export function fileSize(bytes = 0) {
  if (bytes < 1024) return t('{0} Б', { 0: bytes });
  const units = [t('КБ'), t('МБ'), t('ГБ')];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? (lang === 'ru' ? v.toFixed(1).replace('.', ',') : v.toFixed(1)) : Math.round(v)} ${units[i]}`;
}

/** Zalgo text: hundreds of combining marks on one letter. Keep at most two (old messages from before server-side cleanup). */
export const cleanText = (t: string) => t.replace(/(\p{Mn}{2})[\p{Mn}\p{Me}]+/gu, '$1');

export const firstPhotoUrl = (atts?: Attachment[]) => atts?.find((a) => !a.video && !a.file)?.url;

export function previewText(m: Pick<ChatMessage, 'content' | 'attachments'>) {
  if (m.content) return cleanText(m.content);
  const list = m.attachments ?? [];
  const n = list.length;
  if (!n) return '';
  const f = list.filter((a) => a.file).length;
  if (f === n) return n === 1 ? list[0].name || t('Файл') : t('Файлы · {0}', { 0: n });
  const v = list.filter((a) => a.video).length;
  const label = f ? t('Вложения') : v === n ? t('Видео') : v ? t('Медиа') : t('Фото');
  return n === 1 ? label : `${label} · ${n}`;
}

export const NAME_RE = /^[A-Za-z][A-Za-z0-9 ._-]{1,31}$/;

/** Names that cannot be taken (same list as the server): @everyone and @here ping the whole chat. */
const RESERVED_NAMES = new Set(['everyone', 'here', 'all', 'channel', 'admin', 'administrator', 'moderator', 'system', 'oreol', 'support']);
export const reservedName = (name: string) => RESERVED_NAMES.has(name.toLowerCase().replace(/[^a-z0-9]/g, ''));
export const MENTION_ALL = ['@everyone', '@here'];

export function normalizeName(raw: string) {
  return raw.replace(/\s+/g, ' ').trim();
}

export function handleOf(name: string) {
  return (
    '@' +
    name
      .toLowerCase()
      .replace(/[\s-]+/g, '.')
      .replace(/[^a-z0-9._]/g, '')
      .replace(/\.{2,}/g, '.')
  );
}

const AVATAR_GRADS = [
  'linear-gradient(135deg,#00e5ff,#2f7bff)',
  'linear-gradient(135deg,#9a8bff,#6342e8)',
  'linear-gradient(135deg,#ffb36b,#ff5c7a)',
  'linear-gradient(135deg,#3ddc97,#00a8cc)',
  'linear-gradient(135deg,#ff6fd8,#7a5cff)',
];

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function nameColor(_name: string) {
  return 'var(--text-primary)';
}

export function avatarGradient(name: string) {
  return AVATAR_GRADS[hash(name) % AVATAR_GRADS.length];
}

export function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
}
