import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { AppState } from '../../app/useAppState';
import { Icon } from '../../shared/icons';
import { handleOf } from '../../shared/model';
import { Avatar } from '../../shared/ui/Avatar';
import { MENTION_EVENT } from '../chat/mentions';
import { getPeerVolume, setPeerVolume, subscribePeerVolume } from '../voice/peerVolume';
import { DisplayName } from './Nick';
import { t } from '../../shared/i18n';

type Open = { name: string; x: number; y: number; mentionOnly?: boolean; inChat?: boolean } | null;
let state: Open = null;
const subs = new Set<() => void>();
const set = (v: Open) => {
  state = v;
  subs.forEach((f) => f());
};
export function openUserMenu(name: string, x: number, y: number, mentionOnly?: boolean, inChat?: boolean) {
  set({ name, x, y, mentionOnly, inChat: inChat ?? mentionOnly });
}
export const userMenuProps = (name: string) => ({
  onContextMenu: (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as Element;
    // The members panel sits beside the open chat: a mention goes to its composer.
    const nextToChat = !!el.closest('aside.members') && !!document.querySelector('.chat .composer');
    openUserMenu(name, e.clientX, e.clientY, false, !!el.closest('.chat') || nextToChat);
  },
});

export function UserMenuHost({ app }: { app: AppState }) {
  const open = useSyncExternalStore(
    (f) => (subs.add(f), () => void subs.delete(f)),
    () => state,
  );
  if (!open) return null;
  return <UserMenu app={app} {...open} onClose={() => set(null)} />;
}

function UserMenu({
  app,
  name,
  x,
  y,
  mentionOnly,
  inChat,
  onClose,
}: {
  app: AppState;
  name: string;
  x: number;
  y: number;
  mentionOnly?: boolean;
  inChat?: boolean;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y, origin: 'top left' });
  const self = name === app.name;
  const vol = useSyncExternalStore(subscribePeerVolume, () => getPeerVolume(name));
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const pad = 8;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const up = y + h + pad > innerHeight;
    const left = Math.max(pad, Math.min(x, innerWidth - w - pad));
    setPos({ left, top: Math.max(pad, up ? y - h : y), origin: `${up ? 'bottom' : 'top'} ${left < x - w / 2 ? 'right' : 'left'}` });
  }, [x, y]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const item = (icon: Parameters<typeof Icon>[0]['name'], label: string, run: () => void) => (
    <button
      role="menuitem"
      className="msg-menu-item"
      onClick={() => {
        onClose();
        run();
      }}
    >
      <Icon name={icon} size={18} />
      <span>{label}</span>
    </button>
  );
  return createPortal(
    <>
      <div className="msg-menu-backdrop" onClick={onClose} onContextMenu={(e) => (e.preventDefault(), onClose())} />
      <div ref={ref} className="msg-menu user-menu" role="menu" style={{ left: pos.left, top: pos.top, transformOrigin: pos.origin }}>
        {mentionOnly ? (
          item('at', t('Упомянуть'), () => window.dispatchEvent(new CustomEvent(MENTION_EVENT, { detail: name })))
        ) : (
        <>
        <div className="um-head">
          <Avatar name={name} size={32} />
          <span className="um-who">
            <b>
              <DisplayName name={name} />
            </b>
            <span>{handleOf(name)}</span>
          </span>
        </div>
        {!self && (
          <label className="um-volume">
            <span className="um-vol-top">
              <Icon name="headphones" size={16} />
              <span>{t('Громкость')}</span>
              <b>{Math.round(vol * 100)}%</b>
            </span>
            <input
              type="range"
              className="range"
              min={0}
              max={200}
              step={1}
              value={Math.round(vol * 100)}
              style={{ ['--p' as string]: `${Math.round(vol * 50)}%` }}
              onChange={(e) => setPeerVolume(name, Number(e.target.value) / 100)}
            />
          </label>
        )}
        {!self && inChat && item('at', t('Упомянуть'), () => window.dispatchEvent(new CustomEvent(MENTION_EVENT, { detail: name })))}
        {!self && item('chats', t('Написать сообщение'), () => app.notify(t('Личные сообщения скоро будут')))}
        {self && item('copy', t('Копировать юзернейм'), () => void navigator.clipboard?.writeText(handleOf(name)))}
        </>
        )}
      </div>
    </>,
    document.body,
  );
}
