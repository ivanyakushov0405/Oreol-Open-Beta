import type { AppState } from '../../app/useAppState';
import { handleOf } from '../../shared/model';
import { mentionsMe } from './mentions';

/** Сколько чужих сообщений пришло после последнего прочитанного. */
/** Красный бейдж непрочитанного: при каждом новом числе — «выпрыгивает»; больше 99 — «99+». */
export function UnreadBadge({ n, className = '' }: { n: number; className?: string }) {
  if (!n) return null;
  return (
    <span key={n} className={'badge unread-badge ' + className} aria-label={`Непрочитанных: ${n}`}>
      {n > 99 ? '99+' : n}
    </span>
  );
}
/** Сколько непрочитанных в чате (чужие сообщения после отметки «прочитано»). */
export function chatUnread(app: AppState, chat: AppState['lobby']) {
  return unreadCount(chat.messages, chat.myRead, app.name);
}

/** Сколько непрочитанных сообщений упоминают тебя. */
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
    // закреп — тоже новость в чате (открепление — нет)
    if ((!m.sys || m.sys === 'pin') && m.user !== me) n++;
  }
  return n;
}
