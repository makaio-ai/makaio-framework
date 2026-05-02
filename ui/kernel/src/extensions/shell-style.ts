/**
 * Shared shell fallback styling constants.
 *
 * These inline values are intentionally kept outside the theme pipeline so the
 * boot splash and empty/error fallback UI render before extension chrome loads.
 * They mirror ui-theme tokens because boot UI can render before renderer CSS
 * has loaded.
 * @packageDocumentation
 */

/** Background colour for shell-level fallback and boot-splash UI. */
export const SHELL_BG_COLOR = '#0d1117';

/** Text colour for shell-level fallback and boot-splash UI. */
export const SHELL_TEXT_COLOR = '#e9eaed';

/** Font stack for shell-level fallback and boot-splash UI. */
export const SHELL_FONT_FAMILY = 'system-ui, sans-serif';
