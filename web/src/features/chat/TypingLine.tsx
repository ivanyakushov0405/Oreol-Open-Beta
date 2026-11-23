import type { ReactNode } from 'react';
import { DisplayName } from '../members/Nick';
import { t } from '../../shared/i18n';

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
      <span className="typing-verb">{users.length === 1 ? t('печатает') : t('печатают')}</span>
      <span className="typing-dots">
        <i />
        <i />
        <i />
      </span>
    </span>
  );
}
