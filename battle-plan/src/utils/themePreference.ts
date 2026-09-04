export const THEME_STORAGE_KEY = 'battleplan_theme';

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = Exclude<ThemePreference, 'system'>;

export function parseThemePreference(value: string | null): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system';
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  return preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;
}

export function readThemePreference(storage?: Pick<Storage, 'getItem'> | null): ThemePreference {
  try {
    const source = storage === undefined ? globalThis.localStorage : storage;
    return parseThemePreference(source?.getItem(THEME_STORAGE_KEY) ?? null);
  } catch {
    return 'system';
  }
}

export function persistThemePreference(preference: ThemePreference, storage?: Pick<Storage, 'setItem' | 'removeItem'>) {
  try {
    const target = storage ?? globalThis.localStorage;
    if (preference === 'system') target.removeItem(THEME_STORAGE_KEY);
    else target.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // The preference remains active for this tab when storage is unavailable.
  }
}
