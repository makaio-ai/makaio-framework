/**
 * Shared focus context type for navigation results.
 *
 * This type is used across multiple packages to define focus contexts
 * for the web/app surface. It's centralized here to avoid duplication.
 * @packageDocumentation
 */

/**
 * Focus context types for navigation results.
 *
 * Represents the different focus areas available in the web/app interface.
 * Used by slash commands, navigation results, and the focus store.
 *
 * The focus store implementation is in `@makaio/ui-hooks`.
 */
export type FocusContext = 'chat' | 'git' | 'review' | 'planning' | 'settings';
