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

/** Fixed for the page's lifetime: switching reloads, so module-level constants can call t() too. */
export const lang: Lang = initialLang();
export const locale = lang === 'ru' ? 'ru-RU' : 'en-US';
document.documentElement.lang = lang;
export const BRAND = 'Oreol Web';
document.title = BRAND;

export function setLang(next: Lang) {
  if (next === lang) return;
  try {
    localStorage.setItem(LS_LANG, next);
  } catch {
    /* storage blocked */
  }
  location.reload();
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
