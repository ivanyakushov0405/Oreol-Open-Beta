import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AppState } from '../../app/useAppState';
import { api } from '../../shared/api';
import { lang, locale, plural, t } from '../../shared/i18n';
import { Icon, type IconName } from '../../shared/icons';
import { fileSize, type Attachment, type Channel, type ChatMessage } from '../../shared/model';
import { Avatar } from '../../shared/ui/Avatar';
import { DisplayName } from '../members/Nick';
import { setMuted, useMuted } from '../notifications/mute';
import { PhotoViewer } from './Photos';

type Chat = AppState['general'];
type Kind = 'photo' | 'video' | 'gif' | 'file' | 'link';
type Meta = { msg: number; user: string; ts: string | null };
type MediaItem = Attachment & Meta;
type LinkItem = Meta & { url: string };
type Page<T> = { items: T[]; next: number | null; loading: boolean; error: boolean };

// Russian uses the same word for one item and for the tab; English tabs are plural.
const TABS: { id: Kind; label: string }[] = [
  { id: 'photo', label: lang === 'en' ? 'Photos' : 'Фото' },
  { id: 'video', label: lang === 'en' ? 'Videos' : 'Видео' },
  { id: 'gif', label: t('GIF') },
  { id: 'file', label: t('Файлы') },
  { id: 'link', label: t('Ссылки') },
];

const dayFmt = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' });
const yearFmt = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' });
function when(iso: string | null) {
  if (!iso) return '';
  const d = new Date(iso);
  return (d.getFullYear() === new Date().getFullYear() ? dayFmt : yearFmt).format(d);
}

/** Cursor-paged list. `base` already has its query string; changing it starts over. */
function usePaged<T>(base: string | null, field: 'items' | 'messages') {
  const [page, setPage] = useState<Page<T>>({ items: [], next: null, loading: false, error: false });
  const state = useRef({ base, next: null as number | null, busy: false, done: false });
  const load = useCallback(
    async (fresh: boolean) => {
      const s = state.current;
      if (!s.base || s.busy || (!fresh && s.done)) return;
      const at = s.base;
      s.busy = true;
      setPage((p) => ({ ...p, loading: true, error: false }));
      try {
        const d = await api<Record<string, unknown> & { next: number | null }>(at + (!fresh && s.next ? `&before=${s.next}` : ''));
        if (state.current.base !== at) return;
        const got = (d[field] as T[]) ?? [];
        s.next = d.next;
        s.done = d.next == null;
        setPage((p) => ({ items: fresh ? got : [...p.items, ...got], next: d.next, loading: false, error: false }));
      } catch {
        if (state.current.base === at) setPage((p) => ({ ...p, loading: false, error: true }));
      } finally {
        if (state.current.base === at) s.busy = false;
      }
    },
    [field],
  );
  useEffect(() => {
    state.current = { base, next: null, busy: false, done: false };
    setPage({ items: [], next: null, loading: !!base, error: false });
    void load(true);
  }, [base, load]);
  return { ...page, more: () => void load(false), retry: () => void load(page.items.length === 0) };
}

/** Calls onMore when the sentinel scrolls into view of root. */
function useSentinel(root: React.RefObject<HTMLElement>, onMore: () => void, active: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef(onMore);
  cb.current = onMore;
  useEffect(() => {
    const el = ref.current;
    if (!el || !active) return;
    const io = new IntersectionObserver((e) => e.some((x) => x.isIntersecting) && cb.current(), { root: root.current, rootMargin: '300px' });
    io.observe(el);
    return () => io.disconnect();
  }, [root, active]);
  return ref;
}

function Status({ page, empty }: { page: { loading: boolean; error: boolean; items: unknown[]; retry: () => void }; empty: string }) {
  if (page.error)
    return (
      <div className="ci-note">
        {t('Не удалось загрузить')}
        <button type="button" className="btn-chip" onClick={page.retry}>
          {t('Повторить')}
        </button>
      </div>
    );
  if (page.loading) return <div className="ci-note"><i className="conn-spin" /></div>;
  if (!page.items.length) return <div className="ci-note">{empty}</div>;
  return null;
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function snippet(text: string, q: string) {
  const at = text.toLowerCase().indexOf(q);
  if (at < 0) return <>{text.slice(0, 160)}</>;
  const from = Math.max(0, at - 50);
  return (
    <>
      {from > 0 && '…'}
      {text.slice(from, at)}
      <mark>{text.slice(at, at + q.length)}</mark>
      {text.slice(at + q.length, at + q.length + 110)}
    </>
  );
}

const MORPH_MS = 460;
const CLOSE_MS = 340;
const MORPH_EASE = 'cubic-bezier(.32, .72, 0, 1)';
/** Header parts hidden while the panel is open: the panel draws its own copy of the header in the same place. */
const HEAD_PARTS = '.pill-btn, .title-pill, .group';
// the swipe header motion from styles.css: head-bump-a, sw-in, sw-out, .group.gone, head-pop-in, head-pop-out
const BUMP: Keyframe[] = [{ transform: 'none' }, { transform: 'scale(.97)', offset: 0.45 }, { transform: 'none' }];
const SW_IN: Keyframe[] = [{ opacity: 0, transform: 'translateY(5px)' }, { opacity: 1, transform: 'none' }];
const SW_OUT: Keyframe[] = [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-5px)' }];
const GONE: Keyframe[] = [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.8)' }];
const POP_IN: Keyframe[] = [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }];
const POP_OUT: Keyframe[] = [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-4px)' }];

/** Static copy of a header part laid over `into` at the same spot, so the panel can animate it away or back. */
function ghost(of: HTMLElement, into: HTMLElement): HTMLElement {
  const a = of.getBoundingClientRect();
  const b = into.getBoundingClientRect();
  const g = of.cloneNode(true) as HTMLElement;
  g.setAttribute('aria-hidden', 'true');
  g.inert = true;
  Object.assign(g.style, {
    position: 'absolute', left: `${a.left - b.left}px`, top: `${a.top - b.top}px`, width: `${a.width}px`, height: `${a.height}px`,
    margin: '0', visibility: 'visible', pointerEvents: 'none',
  });
  into.appendChild(g);
  return g;
}

/**
 * The panel unrolls from the chat header, whose copy it draws in the same place, and the header changes the way
 * it does on a swipe: the back button and the title bump, the title text swaps, the button group shrinks away.
 * The rest pops in one by one. Only transform, clip-path and opacity animate.
 */
function morph(panel: HTMLElement, open: boolean): Promise<void> {
  const head = panel.closest('.m-full')?.querySelector<HTMLElement>(':scope > .m-head');
  const own = panel.querySelector<HTMLElement>(':scope > .ci-head');
  if (!head || !own) return Promise.resolve();
  // closing runs its own keyframes: a reversed open would also reverse the easing and start sluggishly
  const opts: KeyframeAnimationOptions = { duration: open ? MORPH_MS : CLOSE_MS, easing: MORPH_EASE, fill: 'both' };
  const swap = { duration: 380, easing: 'ease', fill: 'both' } as const;
  const anims: Animation[] = [];
  const ghosts: HTMLElement[] = [];
  const play = (el: HTMLElement, from: Keyframe, to: Keyframe) => anims.push(el.animate(open ? [from, to] : [to, from], opts));

  const headBottom = head.getBoundingClientRect().bottom;
  play(panel, { clipPath: `inset(0 0 ${Math.max(0, panel.clientHeight - headBottom)}px 0)` }, { clipPath: 'inset(0 0 0 0)' });

  const srcPill = head.querySelector<HTMLElement>('.title-pill');
  const dstPill = own.querySelector<HTMLElement>('.title-pill');
  if (srcPill && dstPill) {
    const r = getComputedStyle(dstPill).borderRadius;
    const dw = Math.max(0, dstPill.getBoundingClientRect().width - srcPill.getBoundingClientRect().width);
    play(dstPill, { clipPath: `inset(0 ${dw}px 0 0 round ${r})` }, { clipPath: `inset(0 0 0 0 round ${r})` });
    // like the swipe header, only lines whose text changes swap; an unchanged name stays still
    for (const sel of ['.t', '.s']) {
      const oldLine = srcPill.querySelector<HTMLElement>(sel);
      const newLine = dstPill.querySelector<HTMLElement>(sel);
      if (!oldLine || !newLine || oldLine.textContent === newLine.textContent) continue;
      const g = ghost(oldLine, dstPill);
      ghosts.push(g);
      anims.push(g.animate(open ? SW_OUT : SW_IN, swap), newLine.animate(open ? SW_IN : SW_OUT, swap));
    }
  }
  const group = head.querySelector<HTMLElement>('.group');
  if (group) {
    const g = ghost(group, own);
    ghosts.push(g);
    anims.push(g.animate(open ? GONE : [...GONE].reverse(), { duration: 380, easing: 'cubic-bezier(.3, .7, .4, 1)', fill: 'both' }));
  }
  for (const el of own.querySelectorAll<HTMLElement>(':scope > :is(.pill-btn, .title-pill)')) el.animate(BUMP, { duration: 380, easing: 'ease-in-out' });

  const items = [...panel.querySelectorAll<HTMLElement>('.ci-action, :scope > :is(.ci-tabs, .ci-search, .ci-body)')];
  items.forEach((el, i) =>
    anims.push(
      open
        ? el.animate(POP_IN, { duration: 360, easing: MORPH_EASE, delay: 140 + i * 55, fill: 'backwards' })
        : el.animate(POP_OUT, { duration: 220, easing: 'ease-out', fill: 'forwards' }),
    ),
  );

  const parts = [...head.querySelectorAll<HTMLElement>(HEAD_PARTS)];
  parts.forEach((el) => (el.style.visibility = 'hidden'));
  return Promise.all(anims.map((x) => x.finished.catch(() => undefined))).then(() => {
    // the panel's own header stays in the real header's place, so swapping back is seamless
    if (!open) parts.forEach((el) => (el.style.visibility = ''));
    ghosts.forEach((g) => g.remove());
  });
}

export function ChatInfo({
  app,
  chat,
  channel,
  full,
  startSearch,
  onClose,
}: {
  app: AppState;
  chat: Chat;
  channel: Channel;
  /** Phone: a full screen page instead of a dropdown under the title. */
  full?: boolean;
  startSearch?: boolean;
  onClose: () => void;
}) {
  const room = channel.room;
  const [tab, setTab] = useState<Kind>('photo');
  const [search, setSearch] = useState(!!startSearch);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [more, setMore] = useState(false);
  const [viewer, setViewer] = useState<number | null>(null);
  const muted = useMuted(room);
  const body = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const closing = useRef(false);

  useLayoutEffect(() => {
    const el = root.current;
    if (!full || !el) return;
    void morph(el, true);
    const head = el.closest('.m-full')?.querySelector(':scope > .m-head');
    // unmounted without the closing animation (room change, navigation): give the header back
    return () => head?.querySelectorAll<HTMLElement>(HEAD_PARTS).forEach((x) => (x.style.visibility = ''));
  }, [full]);

  const close = useCallback(() => {
    const el = root.current;
    if (!full || !el) return onClose();
    if (closing.current) return;
    closing.current = true;
    void morph(el, false).then(onClose);
  }, [full, onClose]);

  useEffect(() => {
    const id = window.setTimeout(() => setQuery(q.trim().toLowerCase()), 300);
    return () => window.clearTimeout(id);
  }, [q]);
  useEffect(() => {
    if (search) input.current?.focus();
  }, [search]);
  useEffect(() => {
    if (!more) return;
    const off = (e: PointerEvent) => !(e.target as Element).closest?.('.ci-more, .ci-action') && setMore(false);
    document.addEventListener('pointerdown', off);
    return () => document.removeEventListener('pointerdown', off);
  }, [more]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || viewer != null) return;
      if (more) setMore(false);
      else close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close, more, viewer]);

  const enc = encodeURIComponent(room);
  const media = usePaged<MediaItem>(search ? null : `/api/chat/${enc}/media?kind=${tab}&limit=60`, 'items');
  const found = usePaged<ChatMessage>(search && query ? `/api/chat/${enc}/search?q=${encodeURIComponent(query)}&limit=30` : null, 'messages');
  const list = search ? found : media;
  const sentinel = useSentinel(body, list.more, list.next != null && !list.loading);

  useEffect(() => {
    body.current?.scrollTo({ top: 0 });
  }, [tab, search, query]);

  const go = (id: number | string) => {
    close();
    void chat.reveal(id).then((ok) => !ok && app.notify(t('Сообщение не найдено, возможно его удалили')));
  };
  const toggleMute = () => {
    setMuted(room, !muted);
    app.notify(muted ? t('Уведомления включены') : t('Уведомления выключены, кроме упоминаний'), 'success');
  };
  const copyName = () => {
    setMore(false);
    void navigator.clipboard?.writeText(channel.kind === 'voice' ? channel.name : `#${channel.name}`).then(
      () => app.notify(t('Название канала скопировано'), 'success'),
      () => app.notify(t('Не удалось скопировать'), 'error'),
    );
  };
  const lastId = useMemo(() => {
    for (let i = chat.messages.length - 1; i >= 0; i--) if (Number(chat.messages[i].id) > 0) return chat.messages[i].id;
    return null;
  }, [chat.messages]);

  const actions: { icon: IconName; label: string; on?: boolean; run: () => void }[] = [
    { icon: 'search', label: t('Поиск'), on: search, run: () => setSearch((s) => !s) },
    { icon: muted ? 'bell-off' : 'bell', label: muted ? t('Без звука') : t('Уведомления'), on: muted, run: toggleMute },
    { icon: 'more', label: t('Ещё'), on: more, run: () => setMore((m) => !m) },
  ];
  const items = media.items;
  const visual = tab === 'photo' || tab === 'video' || tab === 'gif';

  const panel = (
    <div ref={root} className={'ci' + (full ? ' ci-full' : ' ci-pop glass')} role="dialog" aria-label={t('Информация о чате')}>
      {full ? (
        <div className="m-head ci-head">
          <button type="button" className="pill-btn glass ci-back" title={t('Назад')} aria-label={t('Назад')} onClick={close}>
            <Icon name="back" />
          </button>
          <div className="title-pill glass ci-titlecard">
            <Icon name={channel.kind === 'voice' ? 'voice' : 'chats'} size={24} className="title-ico" />
            <div style={{ minWidth: 0 }}>
              <div className="t">{channel.name}</div>
              <div className="s">
                {app.server.name}
                {app.membersReady && ` · ${plural(app.members.length, 'участник', 'участника', 'участников')}`}
              </div>
            </div>
          </div>
        </div>
      ) : (
      <div className="ci-head">
        <span className="ci-ico">
          <Icon name={channel.kind === 'voice' ? 'voice' : 'chats'} size={22} />
        </span>
        <div className="ci-title">
          <b>{channel.name}</b>
          <span>
            {app.server.name}
            {app.membersReady && ` · ${plural(app.members.length, 'участник', 'участника', 'участников')}`}
          </span>
        </div>
        <button type="button" className="icon-btn" title={t('Закрыть')} aria-label={t('Закрыть')} onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      )}

      <div className="ci-actions">
        {actions.map((a) => (
          <button key={a.icon} type="button" className={'ci-action' + (a.on ? ' on' : '')} aria-pressed={a.on} onClick={a.run}>
            <Icon name={a.icon} />
            <span>{a.label}</span>
          </button>
        ))}
        {more && (
          <div className="ci-more glass" role="menu">
            <button
              role="menuitem"
              className="m-menu-item"
              onClick={() => {
                close();
                chat.setView('pinned');
              }}
            >
              <Icon name="pin" />
              <span>{t('Закреплённые')}</span>
              {chat.pinned.length > 0 && <span className="m-menu-count">{chat.pinned.length}</span>}
            </button>
            <button role="menuitem" className="m-menu-item" onClick={copyName}>
              <Icon name="copy" />
              <span>{t('Копировать название')}</span>
            </button>
            {lastId != null && (
              <button
                role="menuitem"
                className="m-menu-item"
                onClick={() => {
                  setMore(false);
                  chat.markRead(lastId);
                }}
              >
                <Icon name="check-double" />
                <span>{t('Отметить прочитанным')}</span>
              </button>
            )}
          </div>
        )}
      </div>

      {search ? (
        <div className="ci-search">
          <Icon name="search" size={18} />
          <input ref={input} className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Поиск по чату')} maxLength={100} enterKeyHint="search" />
          {q && (
            <button type="button" className="ci-clear" aria-label={t('Закрыть')} onClick={() => setQ('')}>
              <Icon name="close" size={16} />
            </button>
          )}
        </div>
      ) : (
        <div className="ci-tabs" role="tablist">
          {TABS.map((x) => (
            <button key={x.id} role="tab" type="button" aria-selected={tab === x.id} className={tab === x.id ? 'on' : ''} onClick={() => setTab(x.id)}>
              {x.label}
            </button>
          ))}
        </div>
      )}

      <div className="ci-body" ref={body}>
        {search ? (
          <>
            {query && (
              <div className="ci-results">
                {found.items.map((m) => (
                  <button key={m.id} type="button" className="ci-result" onClick={() => go(m.id)}>
                    <Avatar name={m.user} size={32} />
                    <span className="ci-result-main">
                      <span className="ci-result-top">
                        <b>
                          <DisplayName name={m.user} />
                        </b>
                        <span>{when(m.ts ?? null)}</span>
                      </span>
                      <span className="ci-result-text">{snippet(m.content || '', query)}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
            {query && <Status page={found} empty={t('Ничего не найдено')} />}
          </>
        ) : (
          <>
            {visual && (
              <div className="ci-grid">
                {items.map((a, i) => (
                  <button key={a.id} type="button" className="ci-tile" onClick={() => setViewer(i)} title={when(a.ts)}>
                    {a.video ? (
                      <>
                        <video src={a.url + '#t=0.1'} preload="metadata" muted playsInline tabIndex={-1} />
                        <span className="ci-play">
                          <Icon name="play" size={16} />
                        </span>
                      </>
                    ) : (
                      <img src={a.url} alt="" loading="lazy" decoding="async" draggable={false} />
                    )}
                  </button>
                ))}
              </div>
            )}
            {tab === 'file' &&
              items.map((f) => (
                <div key={f.id} className="ci-row">
                  <a className="ci-row-main" href={f.url} download={f.name || true}>
                    <span className="mf-icon">
                      <Icon name="file" size={20} />
                    </span>
                    <span className="ci-row-text">
                      <span className="ci-row-name">{f.name || 'file'}</span>
                      <span className="ci-row-sub">
                        {fileSize(f.size)} · <DisplayName name={f.user} /> · {when(f.ts)}
                      </span>
                    </span>
                  </a>
                  <button type="button" className="icon-btn" title={t('К сообщению')} aria-label={t('К сообщению')} onClick={() => go(f.msg)}>
                    <Icon name="chevron-right" />
                  </button>
                </div>
              ))}
            {tab === 'link' &&
              (items as unknown as LinkItem[]).map((l, i) => (
                <div key={l.msg + ':' + i} className="ci-row">
                  <a className="ci-row-main" href={l.url} target="_blank" rel="noopener noreferrer nofollow">
                    <span className="mf-icon">
                      <Icon name="link" size={20} />
                    </span>
                    <span className="ci-row-text">
                      <span className="ci-row-name">{hostOf(l.url)}</span>
                      <span className="ci-row-sub ci-url">{l.url}</span>
                    </span>
                  </a>
                  <button type="button" className="icon-btn" title={t('К сообщению')} aria-label={t('К сообщению')} onClick={() => go(l.msg)}>
                    <Icon name="chevron-right" />
                  </button>
                </div>
              ))}
            <Status page={media} empty={t('Здесь пока пусто')} />
          </>
        )}
        {list.next != null && list.items.length > 0 && <div ref={sentinel} className="ci-sentinel" />}
      </div>
    </div>
  );

  return (
    <>
      {!full && <div className="popover-backdrop" onClick={onClose} />}
      {panel}
      {viewer != null && visual && <PhotoViewer photos={items} start={viewer} onClose={() => setViewer(null)} />}
    </>
  );
}
