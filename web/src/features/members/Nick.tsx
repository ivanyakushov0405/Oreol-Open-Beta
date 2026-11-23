import type { ReactNode } from 'react';
import { useUser } from '../../shared/api';
import { nameColor } from '../../shared/model';

export function useDisplayName(name: string) {
  return useUser(name)?.displayName || name;
}

export function Nick({ name, children }: { name: string; children?: ReactNode }) {
  const display = useDisplayName(name);
  return (
    <b style={{ color: nameColor(name) }}>
      {display}
      {children}
    </b>
  );
}

export function DisplayName({ name }: { name: string }) {
  return <>{useDisplayName(name)}</>;
}
