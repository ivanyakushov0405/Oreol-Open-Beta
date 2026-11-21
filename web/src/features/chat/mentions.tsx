import type { ReactNode } from 'react';
import { userByTag } from '../../shared/api';
import { handleOf } from '../../shared/model';
import { openProfile } from '../profile/profile';

/** Событие «упомянуть пользователя» (detail: имя) — поле ввода вставляет его @юзернейм. */
export const MENTION_EVENT = 'oreol:mention';

export const LONG_PRESS_MS = 420;

/** @юзернейм в тексте сообщения. */
// латиница и кириллица; точка в конце («@ivan.») к упоминанию не относится
const MENTION_RE = /(^|[^\p{L}\p{N}_.@])(@[\p{L}\p{N}_](?:[\p{L}\p{N}._]*[\p{L}\p{N}_])?)/giu;
export function mentionsMe(text: string, myTag: string) {
  for (const m of text.matchAll(MENTION_RE)) if (m[2].toLowerCase() === myTag) return true;
  return false;
}
/** Текст с подсвеченными упоминаниями (циановые; своё — с подложкой). */
export function withMentions(text: string, myTag: string): ReactNode {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(MENTION_RE)) {
    const start = (m.index ?? 0) + m[1].length;
    if (start > last) out.push(text.slice(last, start));
    const tag = m[2];
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
          openProfile(u.username);
        }}
      >
        {tag}
      </span>,
    );
    last = start + tag.length;
  }
  if (!out.length) return text;
  if (last < text.length) out.push(text.slice(last));
  return out;
}
