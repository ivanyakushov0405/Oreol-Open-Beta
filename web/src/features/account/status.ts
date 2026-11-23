import type { Status } from '../../shared/model';
import { t } from '../../shared/i18n';

export const STATUS_LABEL: Record<Status, string> = { online: t('В сети'), idle: t('Не активен'), dnd: t('Не беспокоить'), offline: t('Не в сети') };
