import type { Status } from '../../shared/model';
import { Avatar } from '../../shared/ui/Avatar';
import { Nick } from './Nick';
import { userMenuProps } from './userMenu';

export function MemberRow({
  name,
  me,
  sub,
  status = 'online',
  onClick,
}: {
  name: string;
  me?: boolean;
  sub: string;
  status?: Status;
  onClick?: (e: React.MouseEvent) => void;
}) {
  return (
    <button className={'member' + (status === 'offline' ? ' offline' : '')} onClick={onClick} {...userMenuProps(name)}>
      <Avatar name={name} size={34} status={status} />
      <span className="info">
        <Nick name={name}>{me && <span className="you-tag"> · вы</span>}</Nick>
        <span>{sub}</span>
      </span>
    </button>
  );
}
