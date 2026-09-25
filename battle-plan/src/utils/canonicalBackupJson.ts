/** Stable object key order; array order remains part of the backup content. */
export function canonicalBackupJson(value: unknown): string {
    return JSON.stringify(value, (_key, entry: unknown) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
        return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)));
    });
}
