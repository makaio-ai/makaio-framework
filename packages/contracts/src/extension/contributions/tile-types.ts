import type { ComponentType } from 'react';
import type { UiContextDimension, UiScope } from './ui-context-types.js';

/** Optional feature flags a tile can declare. */
export interface TileCapabilities {
  /** Whether this tile supports fullscreen mode. */
  supportsFullscreen?: boolean;
}

/**
 * Props passed to tile components.
 *
 * Tiles do not receive host context as direct props; hosts expose context
 * through their UI runtime.
 */
export interface TileProps {
  /** Optional class name for styling. */
  className?: string;
}

/**
 * Icon loader for a tile.
 *
 * Lazy-loads an icon component (typically from `lucide-react`).
 * @example
 * ```typescript
 * icon: () => import('lucide-react').then(m => ({ default: m.Terminal }))
 * ```
 */
export type TileIconLoader = () => Promise<{ default: ComponentType<{ size?: number }> }>;

/**
 * Platform renderers for a tile.
 *
 * SEAM: Currently supports React; additional platforms can be added as optional
 * keys without breaking existing declarations.
 */
export interface TileRenderers {
  /**
   * React renderer for the web UI.
   *
   * Lazy-loaded component module with a default export that accepts
   * {@link TileProps}.
   */
  react: () => Promise<{ default: ComponentType<TileProps> }>;

  /**
   * SEAM: Future platform renderers (e.g. `reactNative`, `electron`).
   *
   * Additional platforms can be added here as optional keys.
   */
  [platform: string]: (() => Promise<{ default: ComponentType<TileProps> }>) | undefined;
}

/**
 * Tile declaration contributed by a package.
 *
 * Packages declare tiles they provide for pane placement. These are registered
 * with `TileRegistry` and shown in the "Add Pane" palette.
 * @example
 * ```typescript
 * const terminalExtension: MakaioExtension = {
 *   name: 'terminal',
 *   ui: {
 *     tiles: [
 *       {
 *         id: 'status',
 *         name: 'Status',
 *         description: 'Runtime status panel',
 *         scope: 'global',
 *         icon: () => import('lucide-react').then(m => ({ default: m.Activity })),
 *         allowMultiple: true,
 *         capabilities: { supportsFullscreen: true },
 *         renderers: {
 *           react: () => import('./ui/StatusTile.js'),
 *         },
 *       },
 *     ],
 *   },
 * };
 * ```
 */
export interface TileDeclaration {
  /**
   * Unique tile identifier.
   *
   * Must be unique across all packages. Use the package name as a prefix to
   * avoid collisions.
   * @example `'status'`, `'session-summary'`
   */
  id: string;
  /**
   * Display name for the tile.
   *
   * Human-readable name shown in the "Add Pane" palette.
   * @example `'Status'`, `'Session Summary'`
   */
  name: string;
  /**
   * Optional description of tile purpose.
   *
   * Shown in the "Add Pane" palette below the name.
   */
  description?: string;
  /**
   * Tile scope — where the tile is available.
   *
   * Defaults to `'any'` when not specified.
   */
  scope?: UiScope;
  /**
   * Icon loader for the tile.
   *
   * Lazy-loads an icon component for the "Add Pane" palette. Required for
   * tiles to appear in the palette.
   */
  icon: TileIconLoader;
  /**
   * Whether multiple instances of this tile are allowed simultaneously.
   *
   * Defaults to `true`. When `false`, only one instance can exist at a time.
   */
  allowMultiple?: boolean;
  /** Optional capability flags for the tile. */
  capabilities?: TileCapabilities;
  /**
   * Context dimensions this tile's state depends on.
   *
   * When declared, the host can remount the tile when any listed dimension
   * changes to prevent stale in-memory state from leaking across contexts.
   */
  contextDependencies?: UiContextDimension[];
  /**
   * Platform-specific renderers.
   *
   * Maps platform names to lazy-loaded component modules. At minimum, the
   * `'react'` platform is required for the web UI.
   */
  renderers: TileRenderers;
}
