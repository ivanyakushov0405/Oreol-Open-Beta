import { useSyncExternalStore } from 'react';
import type { Status } from './model';
import { serverText, t } from './i18n';

export interface PublicUser {
  username: string;
  displayName: string;
  bio: string;
  avatar: string | null;
  banner: string | null;
  createdAt: string | null;
}

export interface Me extends PublicUser {
  id: number;
  email: string;
  phone: string | null;
  status: Status;
}

export interface Member extends PublicUser {
  joinedAt: string | null;
  status: Status;
}

// The session token lives in an HttpOnly cookie; localStorage only keeps a "signed in" hint for the theme script.
const LS_AUTH = 'oreol.auth';
const LS_LEGACY_TOKEN = 'oreol.token';

export function hasSession(): boolean {
  try {
    return localStorage.getItem(LS_AUTH) === '1' || !!localStorage.getItem(LS_LEGACY_TOKEN);
  } catch {
    return false;
  }
}

export function setSession(on: boolean) {
  try {
    if (on) localStorage.setItem(LS_AUTH, '1');
    else localStorage.removeItem(LS_AUTH);
    localStorage.removeItem(LS_LEGACY_TOKEN);
  } catch {
    /* storage unavailable */
  }
}

/** Token saved by builds before the cookie switch; sent once so the server can move it into the cookie. */
function legacyToken(): string | null {
  try {
    return localStorage.getItem(LS_LEGACY_TOKEN);
  } catch {
    return null;
  }
}

export class ApiError extends Error {
  status: number;
  fields: Record<string, string>;
  constructor(message: string, status: number, fields: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

/** Window event: the server no longer accepts the session (signed out elsewhere or account deleted). */
export const SESSION_EXPIRED = 'oreol:session-expired';

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const legacy = legacyToken();
  if (legacy) headers.Authorization = `Bearer ${legacy}`;
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
    throw new ApiError(t('Нет связи с сервером'), 0);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && hasSession()) window.dispatchEvent(new Event(SESSION_EXPIRED));
  if (!res.ok) {
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries((data.fields as Record<string, string>) || {})) fields[k] = serverText(String(v));
    throw new ApiError(data.error ? serverText(data.error) : t('Ошибка {0}', { 0: res.status }), res.status, fields);
  }
  return data as T;
}

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

export function putUser(u: PublicUser) {
  users = { ...users, [key(u.username)]: u };
  emit();
}

let loading: Promise<void> | null = null;
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

export const displayNameOf = (name: string) => users[key(name)]?.displayName || name;

export function useUser(name: string): PublicUser | undefined {
  return useSyncExternalStore(subscribeUsers, () => users[key(name)]);
}

export function useUsers() {
  return useSyncExternalStore(subscribeUsers, () => users);
}

export function userByTag(tag: string, handle: (name: string) => string): PublicUser | undefined {
  const t = tag.toLowerCase();
  return Object.values(users).find((u) => '@' + key(u.username) === t || handle(u.username) === t);
}
