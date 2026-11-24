import type { Status } from '../../shared/model';
import { dateFormat, t } from '../../shared/i18n';

export const STATUS_LABEL: Record<Status, string> = { get online() { return t('В сети'); }, get idle() { return t('Не активен'); }, get dnd() { return t('Не беспокоить'); }, get offline() { return t('Не в сети'); } };

const clock = dateFormat({ hour: '2-digit', minute: '2-digit' });
const day = dateFormat({ day: 'numeric', month: 'short' });

/** "Last seen" line: minutes for the last hour, then today/yesterday with the time, then the date. */
export function lastSeenText(iso: string, now = Date.now()) {
  const at = new Date(iso);
  const min = Math.floor((now - at.getTime()) / 60000);
  if (min < 1) return t('был(а) в сети только что');
  if (min < 60) return t('был(а) в сети {0} мин назад', { 0: min });
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  if (at.getTime() >= midnight) return t('был(а) в сети сегодня в {0}', { 0: clock.format(at) });
  if (at.getTime() >= midnight - 86400000) return t('был(а) в сети вчера в {0}', { 0: clock.format(at) });
  return t('был(а) в сети {0}', { 0: day.format(at) });
}

export function presenceLine(status: Status, lastSeen?: string | null) {
  return status === 'offline' && lastSeen ? lastSeenText(lastSeen) : STATUS_LABEL[status];
}
