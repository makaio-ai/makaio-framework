/**
 * Shared common types used across multiple packages.
 *
 * This package contains types that are shared between different parts
 * of the Makaio system to avoid duplication and ensure consistency.
 * @packageDocumentation
 */

export type { ActionIntent } from './action-intent.js';
export type { FocusContext } from './focus-context.js';
export { isSurfaceVisible } from './surface.js';
export type { SurfaceType, SurfaceVisibility } from './surface.js';
