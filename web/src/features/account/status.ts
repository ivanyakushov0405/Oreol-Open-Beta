import type { Status } from '../../shared/model';

/** Подпись статуса для карточки участника. */
export const STATUS_LABEL: Record<Status, string> = { online: 'В сети', idle: 'Не активен', dnd: 'Не беспокоить', offline: 'Не в сети' };
