import type { Theme } from './types.js';

/**
 * Aura Theme
 *
 * CSS variables live in the ui-theme Aura stylesheet.
 */
export const auraTheme: Theme = {
  id: 'aura',
  name: 'Aura',
  className: 'aura-theme',
};

/**
 * All available themes
 */
export const themes: Record<string, Theme> = {
  aura: auraTheme,
};

/**
 * Default theme ID
 */
export const defaultThemeId = 'aura';
