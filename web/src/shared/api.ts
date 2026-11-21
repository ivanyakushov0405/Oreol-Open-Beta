import { useSyncExternalStore } from 'react';
import type { Status } from './model';

/** Публичный профиль пользователя (как его видят другие). */
export interface PublicUser {
  username: string;
  displayName: string;
  bio: string;
  avatar: string | null;
  banner: string | null;
  createdAt: string | null;
}

/** Свой профиль — плюс email. */
export interface Me extends PublicUser {
  id: number;
  email: string;
  phone: string | null;
  /** Выбранный статус; offline — «невидимый». */
  status: Status;
}

/** Участник сервера: профиль, дата вступления и видимый статус. */
export interface Member extends PublicUser {
  joinedAt: string | null;
  status: Status;
}

const LS_TOKEN = 'oreol.token';

export function getToken(): string | null {
  try {
    return localStorage.getItem(LS_TOKEN);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(LS_TOKEN, token);
    else localStorage.removeItem(LS_TOKEN);
  } catch {
    /* хранилище недоступно */
  }
}

/** Ошибка API: текст для человека и ошибки по полям формы. */
export class ApiError extends Error {
  status: number;
  fields: Record<string, string>;
  constructor(message: string, status: number, fields: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

/** Запрос к API с токеном сессии. Тело-объект уходит как JSON, Blob/File — как есть (загрузка картинок). */
/** Событие окна: токен больше не принимается сервером (сессия завершена или аккаунт удалён). */
export const SESSION_EXPIRED = 'oreol:session-expired';

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let body: BodyInit | undefined;
  if (opts.body instanceof Blob) {
    body = opts.body;
    headers['Content-Type'] = opts.body.type || 'application/octet-stream';
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers['Content-Type'] = 'application/json';
  }
  let res: Response;
  try {
    res = await fetch(path, { method: opts.method ?? (body ? 'POST' : 'GET'), headers, body });
  } catch {
    throw new ApiError('Нет связи с сервером', 0);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) window.dispatchEvent(new Event(SESSION_EXPIRED));
  if (!res.ok) throw new ApiError(data.error || `Ошибка ${res.status}`, res.status, data.fields || {});
  return data as T;
}

/* ---------- Справочник профилей: аватары, фоны и отображаемые имена всех пользователей ---------- */

let users: Record<string, PublicUser> = {};
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function subscribeUsers(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

const key = (name: string) => name.toLowerCase();

/** Обновить свой профиль в справочнике (после сохранения настроек). */
export function putUser(u: PublicUser) {
  users = { ...users, [key(u.username)]: u };
  emit();
}

let loading: Promise<void> | null = null;
/** Загрузить всех пользователей (их немного — «для своих»). */
export function refreshUsers() {
  loading ??= api<{ users: PublicUser[] }>('/api/users')
    .then((r) => {
      const next: Record<string, PublicUser> = {};
      for (const u of r.users) next[key(u.username)] = u;
      users = next;
      emit();
    })
    .catch(() => undefined)
    .finally(() => {
      loading = null;
    });
  return loading;
}

export function clearUsers() {
  users = {};
  emit();
}

/** Профиль по имени пользователя (или undefined, если такого аккаунта нет). */
export function useUser(name: string): PublicUser | undefined {
  return useSyncExternalStore(subscribeUsers, () => users[key(name)]);
}

export function useUsers() {
  return useSyncExternalStore(subscribeUsers, () => users);
}

/** Пользователь по @упоминанию (по юзернейму или его @-форме). */
export function userByTag(tag: string, handle: (name: string) => string): PublicUser | undefined {
  const t = tag.toLowerCase();
  return Object.values(users).find((u) => '@' + key(u.username) === t || handle(u.username) === t);
}
