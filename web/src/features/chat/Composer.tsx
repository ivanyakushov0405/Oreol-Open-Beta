import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../../shared/icons';
import { handleOf } from '../../shared/model';
import { MENTION_EVENT } from './mentions';

export function Composer({
  placeholder,
  onSend,
  onTyping,
  disabled,
  bar,
  seed,
  onCancel,
  onDraft,
}: {
  placeholder: string;
  onSend: (text: string) => boolean;
  onTyping?: () => void;
  disabled?: boolean;
  /** Плашка над полем: «Ответ …» / «Редактирование». */
  bar?: ReactNode;
  /** Подставить текст и поставить курсор в поле (меняется key — срабатывает снова). */
  seed?: { key: number; text: string | null } | null;
  /** Esc в поле — отменить ответ/правку. */
  onCancel?: () => void;
  /** Текущий текст поля — чтобы черновик можно было вернуть после правки сообщения. */
  onDraft?: (text: string) => void;
}) {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    onDraft?.(text);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!seed) return;
    // null — текст не трогаем (ответ на сообщение не стирает черновик), только ставим курсор в поле
    if (seed.text !== null) setText(seed.text);
    const el = inputRef.current;
    if (el) {
      el.focus();
      requestAnimationFrame(() => el.setSelectionRange(el.value.length, el.value.length));
    }
  }, [seed?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const submit = () => {
    if (onSend(text)) setText('');
  };
  // «Упомянуть» из меню пользователя — вставляем его @юзернейм в конец текста
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
  // Лента сообщений уходит под поле ввода до самого низа: сообщаем её контейнеру высоту поля
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
      <button type="button" className="round" title="Вложения — скоро будут" disabled>
        <Icon name="attach" />
      </button>
      <div className={'field' + (bar ? ' has-bar' : '')}>
        {bar}
        <input
          ref={inputRef}
          value={text}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && onCancel) {
              e.preventDefault();
              onCancel();
              setText('');
            }
          }}
          placeholder={placeholder}
          disabled={disabled}
          maxLength={2000}
          onChange={(e) => {
            setText(e.target.value);
            onTyping?.();
          }}
        />
        <button type="button" className="icon-btn" title="Эмодзи" onClick={() => setText((t) => t + '🙂')}>
          <Icon name="smile" />
        </button>
        <button type="submit" className={"send-btn" + (text.trim() ? " show" : "")} title="Отправить" disabled={disabled || !text.trim()} tabIndex={text.trim() ? 0 : -1}>
          <Icon name="send" size={18} />
        </button>
      </div>
    </form>
  );
}
