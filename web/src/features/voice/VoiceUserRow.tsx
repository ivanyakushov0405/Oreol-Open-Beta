import { Icon } from '../../shared/icons';
import { Avatar } from '../../shared/ui/Avatar';
import { DisplayName } from '../members/Nick';
import { userMenuProps } from '../members/userMenu';
import { openProfile } from '../profile/profile';
import { PeerFlags } from './VoiceStage';
import { animClass, type Anim } from './peerAnim';
import type { VoicePeer } from './useVoice';

/* ---------- Список каналов ---------- */
export function VoiceUserRow({ p, anim }: { p: VoicePeer; anim?: Anim }) {
  return (
    // нажатие — профиль (на телефоне ПКМ нет, и участник был «некликабельным»)
    <div className={'voice-user' + animClass(anim)} role="button" tabIndex={0} {...userMenuProps(p.identity)} onClick={(e) => (e.stopPropagation(), openProfile(p.identity))}>
      <Avatar name={p.identity} size={28} speaking={p.speaking} />
      <span className={'name' + (p.speaking ? ' speaking' : '')}>
        {p.mobile && <Icon name="smartphone" size={14} className="dev-phone" />}
        <DisplayName name={p.identity} />
      </span>
      {/* Иконки прижаты вправо, слева направо: видео → демонстрация → наушники → микрофон */}
      <span className="flags">
        <PeerFlags p={p} order="row" />
      </span>
    </div>
  );
}
