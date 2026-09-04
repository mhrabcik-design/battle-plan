import { useCallback, useEffect, useState } from 'react';
import {
  persistThemePreference,
  readThemePreference,
  resolveTheme,
  THEME_STORAGE_KEY,
  type ResolvedTheme,
  type ThemePreference,
} from '../utils/themePreference';

const mediaQuery = '(prefers-color-scheme: dark)';

function applyTheme(theme: ResolvedTheme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  const canvas = getComputedStyle(root).getPropertyValue('--canvas').trim();
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute(
    'content',
    canvas || (theme === 'dark' ? '#05070a' : '#f4f7fb'),
  );
}

export function useThemePreference() {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => readThemePreference());
  const [systemDark, setSystemDark] = useState(() => window.matchMedia(mediaQuery).matches);
  const resolvedTheme = resolveTheme(preference, systemDark);

  useEffect(() => {
    const media = window.matchMedia(mediaQuery);
    const onMediaChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    const onStorage = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY || event.key === null) setPreferenceState(readThemePreference());
    };
    media.addEventListener('change', onMediaChange);
    window.addEventListener('storage', onStorage);
    return () => {
      media.removeEventListener('change', onMediaChange);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  useEffect(() => applyTheme(resolvedTheme), [resolvedTheme]);

  const setPreference = useCallback((next: ThemePreference) => {
    persistThemePreference(next);
    setPreferenceState(next);
  }, []);

  return { preference, setPreference };
}
