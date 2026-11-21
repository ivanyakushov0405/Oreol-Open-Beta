import { useEffect, useRef } from 'react';

// Маршруты интерфейса на History API (без сторонних библиотек).
// Источник правды — состояние экранов; адрес строится из него и, наоборот, при «Назад»/«Вперёд»
// и при открытии ссылки состояние восстанавливается из адреса.
//
//   /                                   — главная (последний сервер)
//   /chats                              — личные сообщения (десктоп) / вкладка «Чаты» (мобильный)
//   /you                                — вкладка «Вы» (мобильный)
//   /servers/:sid                       — сервер
//   /servers/:sid/:cid                  — канал (текстовый или голосовой)
//   /servers/:sid/:cid/chat             — чат голосового канала
//   /servers/:sid/members               — участники (мобильный)
//   /servers/:sid/settings[/:section]   — настройки сервера
//   /settings[/:section]                — настройки пользователя


export type Route =
  | { name: 'home' }
  | { name: 'chats' }
  | { name: 'you' }
  | { name: 'settings'; section?: string }
  | { name: 'server'; sid: string; cid?: string; sub?: 'chat' | 'members' | 'settings'; section?: string };

const seg = (s: string | undefined) => (s ? decodeURIComponent(s) : undefined);

export function parseRoute(path: string): Route {
  const p = path.replace(/\/+$/, '').split('/').filter(Boolean);
  if (!p.length) return { name: 'home' };
  if (p[0] === 'chats') return { name: 'chats' };
  if (p[0] === 'you') return { name: 'you' };
  if (p[0] === 'settings') return { name: 'settings', section: seg(p[1]) };
  if (p[0] === 'servers' && p[1]) {
    const sid = seg(p[1])!;
    if (p[2] === 'members') return { name: 'server', sid, sub: 'members' };
    if (p[2] === 'settings') return { name: 'server', sid, sub: 'settings', section: seg(p[3]) };
    if (p[2]) return { name: 'server', sid, cid: seg(p[2]), sub: p[3] === 'chat' ? 'chat' : undefined };
    return { name: 'server', sid };
  }
  return { name: 'home' };
}

const enc = encodeURIComponent;
export const paths = {
  chats: () => '/chats',
  you: () => '/you',
  settings: (section?: string | null) => (section ? `/settings/${enc(section)}` : '/settings'),
  server: (sid: string) => `/servers/${enc(sid)}`,
  channel: (sid: string, cid: string, chat = false) => `/servers/${enc(sid)}/${enc(cid)}${chat ? '/chat' : ''}`,
  members: (sid: string) => `/servers/${enc(sid)}/members`,
  serverSettings: (sid: string, section?: string | null) => `/servers/${enc(sid)}/settings${section ? `/${enc(section)}` : ''}`,
};

/** Переход «вверх»: закрыли вложенный экран (канал → сервер) или настройки/участников поверх. */
const OVERLAY = /(^|\/)(settings|members)(\/|$)/;
function isUp(from: string, to: string) {
  return from.startsWith(to + '/') || (OVERLAY.test(from) && !OVERLAY.test(to));
}

/** Ждём popstate от собственного history.back() — пока он не пришёл, адрес не трогаем. */
let backPending = false;

/**
 * Связывает адрес со состоянием экранов.
 * - path — адрес, который соответствует текущему состоянию;
 * - apply — привести состояние к адресу (при загрузке, «Назад»/«Вперёд»);
 * - hold — не трогать адрес (идёт анимация закрытия экрана — состояние ещё старое).
 * Закрытие экрана внутри приложения возвращает по истории назад, если предыдущая запись — как раз туда;
 * так кнопка «Назад» браузера/телефона и кнопка «Назад» в шапке ведут себя одинаково.
 */
export function useUrlSync(path: string, apply: (path: string) => void, hold = false) {
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const pathRef = useRef(path);
  pathRef.current = path;
  const ready = useRef(false);

  useEffect(() => {
    const onPop = () => {
      backPending = false;
      applyRef.current(location.pathname);
    };
    window.addEventListener('popstate', onPop);
    // Первый заход: состояние — из адреса; если адрес не разобрался (чужой сервер и т. п.) — поправляем его
    applyRef.current(location.pathname);
    const id = window.setTimeout(() => {
      ready.current = true;
      if (location.pathname !== pathRef.current) history.replaceState({ prev: history.state?.prev ?? null }, '', pathRef.current);
    }, 0);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.clearTimeout(id);
    };
  }, []);

  useEffect(() => {
    if (!ready.current || hold || backPending) return;
    const cur = location.pathname;
    if (cur === path) return;
    // Назад по истории — только когда экран закрывается («вверх») и предыдущая запись как раз туда;
    // переход вперёд к тому же адресу — новая запись, иначе «Назад» потом уводит мимо
    if (history.state?.prev === path && isUp(cur, path)) {
      backPending = true;
      history.back();
      return;
    }
    history.pushState({ prev: cur }, '', path);
  }, [path, hold]);
}
