import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { api, ApiError } from '../../shared/api';
import { Icon } from '../../shared/icons';
import { fileSize, handleOf, MENTION_ALL, MAX_FILE_MB, MAX_PHOTO_MB, MAX_PHOTOS, MAX_VIDEO_MB, PHOTO_TYPES, VIDEO_TYPES, type Attachment } from '../../shared/model';
import { Avatar } from '../../shared/ui/Avatar';
import { DisplayName } from '../members/Nick';
import { MENTION_EVENT } from './mentions';
import { t } from '../../shared/i18n';

export function Composer({
  placeholder,
  onSend,
  onTyping,
  disabled,
  bar,
  seed,
  onCancel,
  onDraft,
  allowPhotos = true,
  onError,
  people = [],
}: {
  people?: string[];
  placeholder: string;
  onSend: (text: string, photos: number[]) => boolean;
  allowPhotos?: boolean;
  onError?: (text: string) => void;
  onTyping?: () => void;
  disabled?: boolean;
  bar?: ReactNode;
  seed?: { key: number; text: string | null } | null;
  onCancel?: () => void;
  onDraft?: (text: string) => void;
}) {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const [caret, setCaret] = useState(0);
  const [pick, setPick] = useState(0);
  const [mentionOff, setMentionOff] = useState<string | null>(null);
  const before = text.slice(0, caret);
  const at = /(^|\s)@([\p{L}\p{N}._]*)$/u.exec(before);
  const query = at ? at[2].toLowerCase() : null;
  const hits =
    query === null || mentionOff === before
      ? []
      : [
          ...people
            .filter((n) => {
              const h = handleOf(n).slice(1).toLowerCase();
              return h.startsWith(query) || n.toLowerCase().startsWith(query) || (query.length > 0 && h.includes(query));
            })
            .slice(0, 6),
          // @everyone / @here go last so nobody pings everyone instead of a person by accident.
          ...MENTION_ALL.filter((t) => t.slice(1).startsWith(query)),
        ];
  const sel = Math.min(pick, Math.max(0, hits.length - 1));
  const insertMention = (n: string) => {
    if (!at) return;
    const start = caret - at[2].length - 1;
    const tag = (n.startsWith('@') ? n : handleOf(n)) + ' ';
    const next = text.slice(0, start) + tag + text.slice(caret).replace(/^\s+/, '');
    setText(next);
    const pos = start + tag.length;
    setCaret(pos);
    setPick(0);
    const el = inputRef.current;
    if (el) {
      el.focus();
      requestAnimationFrame(() => el.setSelectionRange(pos, pos));
    }
  };
  const fileRef = useRef<HTMLInputElement>(null);
  const [photos, setPhotos] = useState<Pending[]>([]);
  const photosRef = useRef(photos);
  photosRef.current = photos;
  // Chat closed: release previews and delete unsent uploads from the server.
  useEffect(
    () => () => {
      photosRef.current.forEach((p) => {
        URL.revokeObjectURL(p.preview);
        if (p.att) void api(`/api/attachments/${p.att.id}`, { method: 'DELETE' }).catch(() => undefined);
      });
    },
    [],
  );
  const addFiles = (files: File[]) => {
    if (!allowPhotos || !files.length) return;
    const room = MAX_PHOTOS - photosRef.current.length;
    const fresh: Pending[] = [];
    for (const file of files) {
      const video = VIDEO_TYPES.includes(file.type);
      // anything that is not a supported photo or video goes as a document
      const doc = !video && !PHOTO_TYPES.includes(file.type);
      const limit = doc ? MAX_FILE_MB : video ? MAX_VIDEO_MB : MAX_PHOTO_MB;
      if (file.size > limit * 1024 * 1024) {
        onError?.(t('«{0}» больше {1} МБ', { 0: file.name, 1: limit }));
        continue;
      }
      if (fresh.length >= room) {
        onError?.(t('В одном сообщении не больше {0} вложений', { 0: MAX_PHOTOS }));
        break;
      }
      const preview = doc ? '' : URL.createObjectURL(file);
      fresh.push({ key: `${Date.now()}-${Math.random()}`, preview, video, doc: doc ? { name: file.name, size: file.size } : undefined });
      const key = fresh[fresh.length - 1].key;
      // The browser reports video dimensions; the server uses them only if it cannot read the file header.
      (doc
        ? Promise.resolve(`/api/attachments?name=${encodeURIComponent(file.name)}`)
        : video
          ? videoSize(preview).then(([w, h]) => `/api/attachments?w=${w}&h=${h}`)
          : Promise.resolve('/api/attachments'))
        .then((url) => api<Attachment>(url, { body: file }))
        .then(
        (att) => {
          // The photo was removed from the composer while uploading: delete it on the server too.
          if (!photosRef.current.some((p) => p.key === key)) {
            void api(`/api/attachments/${att.id}`, { method: 'DELETE' }).catch(() => undefined);
            return;
          }
          setPhotos((list) => list.map((p) => (p.key === key ? { ...p, att } : p)));
        },
        (e: unknown) => {
          onError?.(e instanceof ApiError ? e.message : doc ? t('Не удалось загрузить файл') : video ? t('Не удалось загрузить видео') : t('Не удалось загрузить фото'));
          setPhotos((list) => {
            const gone = list.find((p) => p.key === key);
            if (gone) URL.revokeObjectURL(gone.preview);
            return list.filter((p) => p.key !== key);
          });
        },
      );
    }
    if (fresh.length) setPhotos((list) => [...list, ...fresh]);
    inputRef.current?.focus();
  };
  const removePhoto = (key: string) => {
    const p = photosRef.current.find((x) => x.key === key);
    if (!p) return;
    URL.revokeObjectURL(p.preview);
    if (p.att) void api(`/api/attachments/${p.att.id}`, { method: 'DELETE' }).catch(() => undefined);
    setPhotos((list) => list.filter((x) => x.key !== key));
  };
  const shownPhotos = allowPhotos ? photos : [];
  const uploading = shownPhotos.some((p) => !p.att);
  const canSend = !uploading && (!!text.trim() || shownPhotos.length > 0);
  useEffect(() => {
    onDraft?.(text);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!seed) return;
    // null keeps the text (replying does not erase the draft) and only focuses the field.
    if (seed.text !== null) setText(seed.text);
    const el = inputRef.current;
    if (el) {
      el.focus();
      requestAnimationFrame(() => el.setSelectionRange(el.value.length, el.value.length));
    }
  }, [seed?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const submit = () => {
    if (!canSend) return;
    const ids = shownPhotos.map((p) => p.att!.id);
    if (!onSend(text, ids)) return;
    setText('');
    if (ids.length) {
      shownPhotos.forEach((p) => URL.revokeObjectURL(p.preview));
      setPhotos([]);
    }
  };
  useEffect(() => {
    const onMention = (e: Event) => {
      const tag = handleOf((e as CustomEvent<string>).detail) + ' ';
      setText((t) => (t && !/\s$/.test(t) ? t + ' ' : t) + tag);
      const el = inputRef.current;
      if (el) {
        el.focus();
        requestAnimationFrame(() => el.setSelectionRange(el.value.length, el.value.length));
      }
    };
    window.addEventListener(MENTION_EVENT, onMention);
    return () => window.removeEventListener(MENTION_EVENT, onMention);
  }, []);
  // The message list runs under the composer, so it needs the composer height.
  const formRef = useRef<HTMLFormElement>(null);
  useLayoutEffect(() => {
    const el = formRef.current;
    const box = el?.parentElement;
    if (!el || !box) return;
    const set = () => box.style.setProperty('--composer-h', `${el.offsetHeight}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => {
      ro.disconnect();
      box.style.removeProperty('--composer-h');
    };
  }, []);
  return (
    <form
      ref={formRef}
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <button
        type="button"
        className="round"
        title={allowPhotos ? t('Прикрепить фото, видео или файл') : t('Вложения нельзя добавить при правке')}
        disabled={disabled || !allowPhotos || photos.length >= MAX_PHOTOS}
        onClick={() => fileRef.current?.click()}
      >
        <Icon name="attach" />
      </button>
      <input
        ref={fileRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          addFiles(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
      {hits.length > 0 && (
        <div className="mention-pop" role="listbox" aria-label={t('Кого упомянуть')}>
          {hits.map((n, i) => (
            <button
              key={n}
              type="button"
              role="option"
              aria-selected={i === sel}
              className={'mention-opt' + (i === sel ? ' on' : '')}
              // Keep focus in the field so the phone keyboard stays open.
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => insertMention(n)}
            >
              {n.startsWith('@') ? (
                <>
                  <span className="mo-all">
                    <Icon name="users" size={16} />
                  </span>
                  <span className="mo-name">{n === '@here' ? t('Все, кто в сети') : t('Все в чате')}</span>
                  <span className="mo-tag">{n}</span>
                </>
              ) : (
                <>
                  <Avatar name={n} size={28} />
                  <span className="mo-name">
                    <DisplayName name={n} />
                  </span>
                  <span className="mo-tag">{handleOf(n)}</span>
                </>
              )}
            </button>
          ))}
        </div>
      )}
      <div className={'field' + (bar || shownPhotos.length ? ' has-bar' : '')}>
        {bar}
        {shownPhotos.length > 0 && (
          <div className="composer-photos">
            {shownPhotos.map((p) => (
              <div className={'cp-item' + (p.att ? '' : ' loading') + (p.doc ? ' cp-doc' : '')} key={p.key} title={p.doc?.name}>
                {p.doc ? (
                  <span className="cp-doc-body">
                    <Icon name="file" size={20} />
                    <span className="cp-doc-name">{p.doc.name}</span>
                    <span className="cp-doc-size">{fileSize(p.doc.size)}</span>
                  </span>
                ) : p.video ? (
                  <video src={p.preview} muted playsInline preload="metadata" />
                ) : (
                  <img src={p.preview} alt="" />
                )}
                {p.video && <span className="cp-video"><Icon name="play" size={12} /></span>}
                {!p.att && <span className="cp-spin" aria-label={t('Загружается')} />}
                <button type="button" className="cp-remove" title={t('Убрать вложение')} onClick={() => removePhoto(p.key)}>
                  <Icon name="close" size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
        <input
          ref={inputRef}
          value={text}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onKeyDown={(e) => {
            if (hits.length) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                setPick((sel + (e.key === 'ArrowDown' ? 1 : hits.length - 1)) % hits.length);
                return;
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                insertMention(hits[sel]);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setMentionOff(before);
                return;
              }
            }
            if (e.key === 'Escape' && onCancel) {
              e.preventDefault();
              onCancel();
              setText('');
            }
          }}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'));
            if (files.length && allowPhotos) {
              e.preventDefault();
              addFiles(files);
            }
          }}
          placeholder={shownPhotos.length ? t('Подпись') : placeholder}
          disabled={disabled}
          maxLength={2000}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            setPick(0);
            onTyping?.();
          }}
        />
        <button
          type="button"
          className="icon-btn"
          title={t('Смайлик')}
          disabled={disabled}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => {
            const e = EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
            if (!text.trim() && !shownPhotos.length) onSend(e, []);
            else setText((t) => t + e);
          }}
        >
          <Icon name="smile" />
        </button>
        <button
          type="submit"
          className={'send-btn' + (text.trim() || shownPhotos.length ? ' show' : '')}
          title={uploading ? t('Фото ещё загружаются') : t('Отправить')}
          disabled={disabled || !canSend}
          tabIndex={canSend ? 0 : -1}
        >
          <Icon name="send" size={18} />
        </button>
      </div>
    </form>
  );
}

const EMOJIS = ['🙂', '🤡'];

interface Pending {
  key: string;
  preview: string;
  att?: Attachment;
  video?: boolean;
  doc?: { name: string; size: number };
}

function videoSize(src: string): Promise<[number, number]> {
  return new Promise((done) => {
    const v = document.createElement('video');
    const fin = (r: [number, number]) => {
      window.clearTimeout(t);
      v.removeAttribute('src');
      v.load();
      done(r);
    };
    const t = window.setTimeout(() => fin([16, 9]), 4000);
    v.preload = 'metadata';
    v.muted = true;
    v.onloadedmetadata = () => fin(v.videoWidth && v.videoHeight ? [v.videoWidth, v.videoHeight] : [16, 9]);
    v.onerror = () => fin([16, 9]);
    v.src = src;
  });
}
