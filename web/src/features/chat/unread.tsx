import type { AppState } from '../../app/useAppState';
import { handleOf } from '../../shared/model';
import { mentionsMe } from './mentions';
import { NEW_MESSAGE, type NewMessage } from './useChat';
import { t } from '../../shared/i18n';

/** When a message last arrived in each room: a badge bounces only right after that, not every time it is shown again. */
const arrived = new Map<string, number>();
window.addEventListener(NEW_MESSAGE, (e) => arrived.set((e as CustomEvent<NewMessage>).detail.room, Date.now()));
export const justArrived = (rooms?: (string | null)[]) => !rooms || rooms.some((r) => !!r && Date.now() - (arrived.get(r) ?? 0) < 1500);

export function UnreadBadge({ n, className = '', rooms }: { n: number; className?: string; rooms?: (string | null)[] }) {
  if (!n) return null;
  return (
    <span key={n} className={'badge unread-badge ' + className + (justArrived(rooms) ? '' : ' still')} aria-label={t('Непрочитанных: {0}', { 0: n })}>
      {n > 99 ? '99+' : n}
    </span>
  );
}
export function chatUnread(app: AppState, chat: AppState['lobby']) {
  return unreadCount(chat.messages, chat.myRead, app.name);
}

/** Unread in a room: live from its chat once the socket delivered history, the server's summary before that
 * (right after a reload or a server switch the chat is empty or a stale cache). */
export function roomUnread(app: AppState, chat: AppState['lobby'] | null, room: string) {
  const own = !!chat && chat.room === room;
  const n = own ? unreadCount(chat.messages, chat.myRead, app.name) : 0;
  const at = own ? unreadMentions(chat.messages, chat.myRead, app.name) : 0;
  if (own && chat.synced) return { n, at };
  const s = app.roomUnread[room];
  return { n: Math.max(n, s?.count ?? 0), at: Math.max(at, s?.mentions ?? 0) };
}

export function unreadMentions(messages: { id: string | number; user: string; sys?: string | null; content?: string | null }[], readId: number, me: string) {
  const tag = handleOf(me);
  let n = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (Number(m.id) <= readId) break;
    if (!m.sys && m.user !== me && mentionsMe(m.content || '', tag)) n++;
  }
  return n;
}

export function unreadCount(messages: { id: string | number; user: string; sys?: string | null }[], readId: number, me: string) {
  let n = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (Number(m.id) <= readId) break;
    if ((!m.sys || m.sys === 'pin') && m.user !== me) n++;
  }
  return n;
}
