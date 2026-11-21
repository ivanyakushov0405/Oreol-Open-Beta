import type { ReactNode } from 'react';
import { DisplayName } from '../members/Nick';

/** «Имя печатает…»: при нехватке места обрезается имя, а «печатает» и точки остаются видны. */
export function TypingLine({ users, fallback }: { users: string[]; fallback: ReactNode }) {
  if (!users.length) return <>{fallback}</>;
  const shown = users.slice(0, 2);
  return (
    <span className="typing-line">
      <span className="typing-who">
        {shown.map((u, i) => (
          <span key={u}>
            {i > 0 && ', '}
            <DisplayName name={u} />
          </span>
        ))}
      </span>
      <span className="typing-verb">{users.length === 1 ? 'печатает' : 'печатают'}</span>
      <span className="typing-dots">
        <i />
        <i />
        <i />
      </span>
    </span>
  );
}
