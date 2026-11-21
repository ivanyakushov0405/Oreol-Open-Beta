import { useRef, useState } from 'react';
import type { AppState } from '../../app/useAppState';
import { Icon, StrikeIcon } from '../../shared/icons';
import { handleOf } from '../../shared/model';
import { Avatar } from '../../shared/ui/Avatar';
import { useMicLevel } from '../voice/micLevel';
import { AccountMenu } from './AccountMenu';

/* ---------- Панель пользователя ---------- */
export function UserPanel({
  app,
  onSettings,
  onProfile,
  onStage = false,
}: {
  app: AppState;
  onSettings: () => void;
  onProfile?: () => void;
  /** Открыт сервер, в войсе которого мы сидим, — нас уже видно (и подсвечивает) в списке каналов, кольца на аватарке не нужно. */
  onStage?: boolean;
}) {
  const v = app.voice;
  const [menu, setMenu] = useState(false);
  // В звонке иконка микрофона заполняется цианом по уровню голоса, а пока говоришь — кольцо вокруг аватарки.
  // Если открыт сервер, в войсе которого сидим, кольца нет: нас уже подсвечивает список каналов.
  const micLive = v.micOn && v.state === 'connected';
  const panel = useRef<HTMLDivElement>(null);
  useMicLevel(panel, micLive, v.micTrack);
  return (
    <div className={'user-panel' + (onStage ? ' on-stage' : '')} ref={panel}>
      {menu && (
        <AccountMenu
          app={app}
          onClose={() => setMenu(false)}
          onSettings={() => {
            setMenu(false);
            onSettings();
          }}
          onProfile={() => {
            setMenu(false);
            (onProfile ?? onSettings)();
          }}
        />
      )}
      <Avatar name={app.name} size={34} status={app.status} />
      <button
        className={'who' + (menu ? ' on' : '')}
        onClick={() => setMenu((m) => !m)}
        title="Статус и аккаунт"
        aria-haspopup="menu"
        aria-expanded={menu}
      >
        <b>{app.me.displayName}</b>
        <span>{handleOf(app.name)}</span>
      </button>
      <button
        className={'icon-btn mic-lvl' + (!v.micOn ? ' danger' : '')}
        title={v.micOn ? 'Выключить микрофон' : 'Включить микрофон'}
        onClick={() => void v.toggleMic()}
      >
        <StrikeIcon name="mic" off={!v.micOn} />
        {micLive && <Icon name="mic" className="mic-fill" />}
      </button>
      <button
        className={'icon-btn' + (v.deafened ? ' danger' : '')}
        title={v.deafened ? 'Включить звук' : 'Выключить звук'}
        onClick={v.toggleDeafen}
      >
        <StrikeIcon name="headphones" off={v.deafened} />
      </button>
      <button className="icon-btn" title="Настройки" onClick={onSettings}>
        <Icon name="settings" />
      </button>
    </div>
  );
}
