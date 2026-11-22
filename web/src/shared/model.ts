// Типы и утилиты интерфейса. Серверы, каналы и участники приходят с бэкенда (/api/servers),
// здесь их нет. Мок остаётся только у витрины ролей (ROLES) в настройках сервера.

export type Status = 'online' | 'idle' | 'dnd' | 'offline';

export interface Channel {
  /** Идентификатор канала внутри сервера (slug). */
  id: string;
  name: string;
  kind: 'text' | 'voice';
  /** Комната чата на бэкенде (WebSocket /api/ws/{room}). */
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
  /** Сообщение удалили — оно ещё на экране, пока проигрывается анимация ухода (только на клиенте). */
  leaving?: boolean;
  user: string;
  content: string;
  ts: string | null;
  /** Когда сообщение изменили (ISO), иначе null. */
  edited?: string | null;
  pinned?: boolean;
  /** Ответ на сообщение: короткая копия оригинала (или пометка, что его удалили). */
  /** photo — первое фото оригинала, миниатюра в цитате. */
  reply?: { id: number | string; user?: string; content?: string; photo?: string | null; deleted?: boolean } | null;
  /** Пересланное: автор оригинала и когда он его написал. */
  fwd?: { user: string; ts: string | null } | null;
  /** Служебная строка ленты: 'pin' — user закрепил сообщение reply.id. */
  sys?: string | null;
  /** Сколько раз на сообщение ответили. */
  replies?: number;
  /** Фото в сообщении (размеры — для раскладки коллажа до загрузки картинки). */
  attachments?: Attachment[];
}

export interface Attachment {
  id: number;
  url: string;
  w: number;
  h: number;
}

/** Ограничения фото — те же, что проверяет сервер. */
export const MAX_PHOTOS = 10;
export const MAX_PHOTO_MB = 10;
export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/** Короткий текст сообщения для цитат, закрепов и уведомлений: у сообщения из одних фото — «Фото». */
export function previewText(m: Pick<ChatMessage, 'content' | 'attachments'>) {
  if (m.content) return m.content;
  const n = m.attachments?.length ?? 0;
  return n === 1 ? 'Фото' : n ? `Фото · ${n}` : '';
}

/** Имя при входе: латиница, цифры, пробел, точка, дефис, подчёркивание; 2–32 символа. */
export const NAME_RE = /^[A-Za-z][A-Za-z0-9 ._-]{1,31}$/;

export function normalizeName(raw: string) {
  return raw.replace(/\s+/g, ' ').trim();
}

/** Юзернейм формируется из имени: «Ivan Petrov» → @ivan.petrov */
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

/** Цвет ника. В макете он задаётся ролью; у подключившихся пользователей ролей нет — цвет общий. */
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
