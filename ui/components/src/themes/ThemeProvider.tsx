import { createContext, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { themes, defaultThemeId } from './tokens.js';
import type { Theme } from './types.js';

export interface ThemeContextValue {
  theme: Theme;
  themeId: string;
  setThemeId: (id: string) => void;
  availableThemes: string[];
}

export const ThemeContext = createContext<ThemeContextValue | null>(null);

const STORAGE_KEY = 'makaio-theme';

/** All valid theme IDs, computed once at module load. */
const AVAILABLE_THEME_IDS = Object.keys(themes);

/** All theme class names, used to remove stale classes from the document root. */
const THEME_CLASSES = Object.values(themes).map((entry) => entry.className);

interface ThemeProviderProps {
  children: ReactNode;
  defaultTheme?: string;
}

/**
 * ThemeProvider
 *
 * Provides theme context and injects CSS custom properties.
 * Persists theme selection to localStorage.
 * @param props - Component props
 */
export function ThemeProvider({ children, defaultTheme = defaultThemeId }: ThemeProviderProps) {
  const [themeId, setThemeIdState] = useState<string>(() => {
    if (typeof window === 'undefined') return defaultTheme;
    try {
      return localStorage.getItem(STORAGE_KEY) ?? defaultTheme;
    } catch {
      return defaultTheme;
    }
  });

  const resolvedThemeId = useMemo(() => {
    if (themes[themeId]) return themeId;
    if (themes[defaultTheme]) return defaultTheme;
    return defaultThemeId;
  }, [themeId, defaultTheme]);

  const theme = useMemo(() => themes[resolvedThemeId], [resolvedThemeId]);

  const setThemeId = useCallback((id: string) => {
    if (themes[id]) {
      setThemeIdState(id);
      try {
        localStorage.setItem(STORAGE_KEY, id);
      } catch (error) {
        console.warn('[ThemeProvider] Failed to persist theme selection', error);
      }
    }
  }, []);

  // Normalize persisted state when the stored theme ID is no longer valid
  // (e.g. a theme was removed between versions). Without this effect the
  // internal state and localStorage would stay stale even though resolvedThemeId
  // already corrected the rendered theme.
  useEffect(() => {
    if (themeId === resolvedThemeId) return;
    setThemeIdState(resolvedThemeId);
    try {
      localStorage.setItem(STORAGE_KEY, resolvedThemeId);
    } catch {
      // Ignore storage errors
    }
  }, [themeId, resolvedThemeId]);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove(...THEME_CLASSES);
    root.classList.add(theme.className);
  }, [theme]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      themeId: resolvedThemeId,
      setThemeId,
      availableThemes: AVAILABLE_THEME_IDS,
    }),
    [theme, resolvedThemeId, setThemeId],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
