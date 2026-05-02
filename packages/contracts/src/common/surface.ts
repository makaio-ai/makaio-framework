/**
 * Surface type definitions shared across all packages.
 *
 * These are the canonical surface types used throughout the system.
 * Both the contracts-level page metadata and the framework-level
 * page definitions reference these types.
 * @packageDocumentation
 */

/**
 * Rendering surface identifiers.
 *
 * Each surface represents a distinct runtime environment:
 * - 'web': Browser-based React DOM rendering
 * - 'mobile': React Native rendering (iOS/Android)
 * - 'electron': Desktop Electron rendering (superset of web)
 * - 'electrobun': Desktop Electrobun rendering (Bun-native alternative to Electron)
 * - 'tray': Lightweight tray popover canvas (subset of desktop)
 *
 * SEAM: New surfaces can be added here as the platform expands.
 */
export type SurfaceType = 'web' | 'mobile' | 'electron' | 'electrobun' | 'tray';

/**
 * Page surface visibility configuration.
 *
 * Controls which rendering surfaces a page appears on:
 * - `'all'`: Available on every surface (default when omitted)
 * - `SurfaceType[]`: Restricted to listed surfaces only
 * @example
 * ```typescript
 * // Available everywhere
 * surfaces: 'all'
 *
 * // Web and electron only
 * surfaces: ['web', 'electron']
 *
 * // Mobile only
 * surfaces: ['mobile']
 * ```
 */
export type SurfaceVisibility = 'all' | SurfaceType[];

/**
 * Check if a page is visible on a given surface.
 * @param visibility - Page surface visibility configuration
 * @param surface - Surface to check against
 * @returns True if the page should be visible on the surface
 */
export function isSurfaceVisible(visibility: SurfaceVisibility | undefined, surface: SurfaceType): boolean {
  if (!visibility || visibility === 'all') {
    return true;
  }
  return visibility.includes(surface);
}
