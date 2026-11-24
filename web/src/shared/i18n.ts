import { EN, EN_PATTERNS } from './en';

export type Lang = 'ru' | 'en';
const LS_LANG = 'oreol.lang';

function initialLang(): Lang {
  try {
    const v = localStorage.getItem(LS_LANG);
    if (v === 'ru' || v === 'en') return v;
  } catch {
    /* storage blocked */
  }
  return (navigator.languages?.[0] || navigator.language || '').toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

/**
 * Switches live, without a reload: the app re-renders through onLang listeners. So text must be translated when it
 * renders; a module-level constant holds the Russian key or a getter, and dates go through dateFormat().
 */
export let lang: Lang = initialLang();
export let locale = lang === 'ru' ? 'ru-RU' : 'en-US';
document.documentElement.lang = lang;
export const BRAND = 'Oreol Web';
document.title = BRAND;

const listeners = new Set<() => void>();
/** The listener must update the DOM synchronously (flushSync), so the switch lands in one frame. */
export function onLang(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export function setLang(next: Lang) {
  if (next === lang) return;
  try {
    localStorage.setItem(LS_LANG, next);
  } catch {
    /* storage blocked */
  }
  const root = document.documentElement;
  lang = next;
  locale = next === 'ru' ? 'ru-RU' : 'en-US';
  root.lang = next;
  // The app re-renders in place within this frame: no remount, so nothing animates in again
  // and the glass stays as it is (a crossfade snapshot showed it untinted).
  for (const fn of listeners) fn();
}

const formats = new Map<string, Intl.DateTimeFormat>();
/** A DateTimeFormat that follows the current language. */
export function dateFormat(opts: Intl.DateTimeFormatOptions) {
  const key = JSON.stringify(opts);
  return {
    format(d?: Date | number) {
      let f = formats.get(locale + key);
      if (!f) formats.set(locale + key, (f = new Intl.DateTimeFormat(locale, opts)));
      return f.format(d);
    },
  };
}

const fill = (s: string, vars?: Record<string, string | number>) =>
  vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;

/** Russian source text is the key; `{name}` placeholders are filled from vars. */
export function t(ru: string, vars?: Record<string, string | number>) {
  return fill(lang === 'en' ? (EN[ru] ?? ru) : ru, vars);
}

/** "5 участников" / "5 members". The English entry "#" + one holds "singular|plural". */
export function plural(n: number, one: string, few: string, many: string) {
  if (lang === 'en') {
    const [s, p] = (EN['#' + one] ?? one).split('|');
    return `${n} ${n === 1 ? s : (p ?? s)}`;
  }
  const m10 = n % 10;
  const m100 = n % 100;
  const w = m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  return `${n} ${w}`;
}

/** Server errors arrive in Russian; some carry numbers, so those are matched by pattern. */
export function serverText(msg: string) {
  if (lang !== 'en') return msg;
  if (EN[msg]) return EN[msg];
  for (const [re, en] of EN_PATTERNS) {
    const m = msg.match(re);
    if (m) return en.replace(/\$(\d)/g, (_, i: string) => m[Number(i)] ?? '');
  }
  return msg;
}
