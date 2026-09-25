import type { Setting } from '../db.ts';

export const TASK_BACKUP_SETTING_IDS = ['gemini_model', 'ui_scale'];

/** Cloud backups carry preferences only. Credentials always belong to this device. */
export function filterTaskBackupSettings(settings: readonly Setting[] | undefined): Setting[] {
    if (!Array.isArray(settings)) return [];
    return settings.filter((setting) => setting && TASK_BACKUP_SETTING_IDS.includes(setting.id) && typeof setting.value === 'string' && (
        setting.id !== 'ui_scale' || (Number.isFinite(Number(setting.value)) && Number(setting.value) > 0)
    )).map(({ id, value }) => ({ id, value }));
}
