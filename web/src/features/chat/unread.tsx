import type { AppState } from '../../app/useAppState';
import { handleOf } from '../../shared/model';
import { mentionsMe } from './mentions';
import { t } from '../../shared/i18n';

export function UnreadBadge({ n, className = '' }: { n: number; className?: string }) {
  if (!n) return null;
  return (
    <span key={n} className={'badge unread-badge ' + className} aria-label={t('Непрочитанных: {0}', { 0: n })}>
      {n > 99 ? '99+' : n}
    </span>
  );
}
export function chatUnread(app: AppState, chat: AppState['lobby']) {
  return unreadCount(chat.messages, chat.myRead, app.name);
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
