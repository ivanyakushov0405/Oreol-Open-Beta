import { useRef, useState } from 'react';
import type { AppState } from '../../app/useAppState';
import { Icon, StrikeIcon } from '../../shared/icons';
import { handleOf } from '../../shared/model';
import { Avatar } from '../../shared/ui/Avatar';
import { useMicLevel } from '../voice/micLevel';
import { AccountMenu } from './AccountMenu';
import { t } from '../../shared/i18n';

export function UserPanel({
  app,
  onSettings,
  onProfile,
  onStage = false,
}: {
  app: AppState;
  onSettings: () => void;
  onProfile?: () => void;
  onStage?: boolean;
}) {
  const v = app.voice;
  const [menu, setMenu] = useState(false);
  // No ring when the open server is the one whose voice we are in: the channel list already highlights us.
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
        title={t('Статус и аккаунт')}
        aria-haspopup="menu"
        aria-expanded={menu}
      >
        <b>{app.me.displayName}</b>
        <span>{handleOf(app.name)}</span>
      </button>
      <button
        className={'icon-btn mic-lvl' + (!v.micOn ? ' danger' : '')}
        title={v.micOn ? t('Выключить микрофон') : t('Включить микрофон')}
        onClick={() => void v.toggleMic()}
      >
        <StrikeIcon name="mic" off={!v.micOn} />
        {micLive && <Icon name="mic" className="mic-fill" />}
      </button>
      <button
        className={'icon-btn' + (v.deafened ? ' danger' : '')}
        title={v.deafened ? t('Включить звук') : t('Выключить звук')}
        onClick={v.toggleDeafen}
      >
        <StrikeIcon name="headphones" off={v.deafened} />
      </button>
      <button className="icon-btn" title={t('Настройки')} onClick={onSettings}>
        <Icon name="settings" />
      </button>
    </div>
  );
}
