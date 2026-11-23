import type { ReactNode } from 'react';
import { userByTag } from '../../shared/api';
import { cleanText, handleOf, MENTION_ALL } from '../../shared/model';
import { openProfile } from '../profile/profile';

/** Событие «упомянуть пользователя» (detail: имя) — поле ввода вставляет его @юзернейм. */
export const MENTION_EVENT = 'oreol:mention';

export const LONG_PRESS_MS = 420;

/** @юзернейм в тексте сообщения. */
// латиница и кириллица; точка в конце («@ivan.») к упоминанию не относится
const MENTION_RE = /(^|[^\p{L}\p{N}_.@])(@[\p{L}\p{N}_](?:[\p{L}\p{N}._]*[\p{L}\p{N}_])?)/giu;
/** Сообщение зовёт меня: по юзернейму или через @everyone / @here. */
export function mentionsMe(text: string, myTag: string) {
  for (const m of text.matchAll(MENTION_RE)) {
    const t = m[2].toLowerCase();
    if (t === myTag || MENTION_ALL.includes(t)) return true;
  }
  return false;
}
/** Ссылка в тексте: http(s)://… или www.…; знаки препинания в конце к ней не относятся. */
const URL_RE = /(?<![A-Za-z0-9_./@])(?:https?:\/\/|www\.)[^\s<>"]+[^\s<>".,;:!?)\]}'»]/gi;
export const linkHref = (u: string) => (/^https?:/i.test(u) ? u : 'https://' + u);
/** Первая ссылка сообщения — для карточки предпросмотра. */
export function firstLink(text: string) {
  const m = text.match(URL_RE);
  return m ? linkHref(m[0]) : null;
}
function withLinks(text: string, keyBase: number): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const i = m.index ?? 0;
    if (i > last) out.push(text.slice(last, i));
    out.push(
      <a
        key={`l${keyBase + i}`}
        className="msg-link"
        href={linkHref(m[0])}
        target="_blank"
        rel="noopener noreferrer nofollow"
        onClick={(e) => e.stopPropagation()}
      >
        {m[0]}
      </a>,
    );
    last = i + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
/** Текст с подсвеченными упоминаниями (циановые; своё — с подложкой). */
export function withMentions(text: string, myTag: string): ReactNode {
  text = cleanText(text);
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(MENTION_RE)) {
    const start = (m.index ?? 0) + m[1].length;
    if (start > last) out.push(...withLinks(text.slice(last, start), last));
    const tag = m[2];
    if (MENTION_ALL.includes(tag.toLowerCase())) {
      out.push(
        <span key={start} className="mention me">
          {tag}
        </span>,
      );
      last = start + tag.length;
      continue;
    }
    out.push(
      <span
        key={start}
        className={'mention' + (tag.toLowerCase() === myTag ? ' me' : '')}
        role="button"
        tabIndex={0}
        onClick={(e) => {
          const u = userByTag(tag, handleOf);
          if (!u) return;
          e.stopPropagation();
          openProfile(u.username, { inChat: true });
        }}
      >
        {tag}
      </span>,
    );
    last = start + tag.length;
  }
  if (last < text.length) out.push(...withLinks(text.slice(last), last));
  return out.length === 1 && typeof out[0] === 'string' ? out[0] : out;
}
