/**
 * Page bus namespace schemas and surface type definitions.
 *
 * Moved here from `@makaio/contracts` — the owning ui-kernel package is the
 * canonical home for its page domain contract.
 * @packageDocumentation
 */
import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';
import type { SurfaceType, UiNavigationLevel } from '@makaio/contracts';

// =============================================================================
// Surface Types
// =============================================================================

/**
 * Zod schema for surface identifiers.
 *
 * Values match {@link SurfaceType} from `@makaio/contracts`.
 * Use this schema for runtime validation in bus payloads.
 */
export const SurfaceIdSchema = z.enum(['web', 'mobile', 'electron', 'electrobun', 'tray']);

/**
 * Surface identifier type — derived from the Zod schema.
 *
 * The compile-time assertion below guarantees this stays in sync
 * with {@link SurfaceType} from `@makaio/contracts`.
 */
export type SurfaceId = z.infer<typeof SurfaceIdSchema>;

/**
 * Compile-time guard: `SurfaceId` (from schema) and `SurfaceType` (canonical)
 * must be mutual subtypes. A type error here means the two definitions drifted.
 */
type _AssertSurfaceSync = SurfaceType extends SurfaceId ? (SurfaceId extends SurfaceType ? true : never) : never;

const _surfaceSyncCheck: _AssertSurfaceSync = true;

/**
 * Surface capabilities that determine what a surface can render.
 *
 * Pages declare required capabilities; surfaces declare what they provide.
 * A page is visible on a surface when the surface provides all required capabilities.
 */
export const SurfaceCapabilitySchema = z.enum([
  /** Full DOM access (web, electron) */
  'dom',
  /** Native mobile APIs (mobile) */
  'native',
  /** File system access (electron, mobile with permissions) */
  'filesystem',
  /** Multi-window support (electron) */
  'multi-window',
  /** Touch-optimized interactions (mobile) */
  'touch',
]);
export type SurfaceCapability = z.infer<typeof SurfaceCapabilitySchema>;

/**
 * Surface declaration - registered by each platform runtime.
 *
 * Describes what a rendering surface supports so the page system can
 * determine page visibility at runtime.
 */
export interface SurfaceDeclaration {
  /** Unique surface identifier */
  readonly id: SurfaceId;
  /** Human-readable surface name */
  readonly name: string;
  /** Capabilities this surface provides */
  readonly capabilities: readonly SurfaceCapability[];
}

/**
 * Page surface visibility configuration.
 *
 * Controls which surfaces a page appears on. Pages can either
 * declare specific surfaces or required capabilities (not both).
 *
 * When neither is specified, the page is available on all surfaces.
 */
export interface PageSurfaceConfig {
  /**
   * Explicit surface allow-list.
   * When set, page only appears on these surfaces.
   * Mutually exclusive with requiredCapabilities.
   */
  readonly surfaces?: readonly SurfaceId[];

  /**
   * Required capabilities for the page to be available.
   * Page appears on any surface that provides all listed capabilities.
   * Mutually exclusive with surfaces.
   */
  readonly requiredCapabilities?: readonly SurfaceCapability[];
}

/**
 * Determine if a page should be visible on a given surface.
 *
 * Resolution order:
 * 1. If `surfaces` is set, check if surface ID is in the list
 * 2. If `requiredCapabilities` is set, check surface provides all of them
 * 3. If neither is set, the page is visible on all surfaces
 * @param config - Page surface configuration
 * @param surface - Surface to check visibility against
 * @returns True if the page should be visible on the surface
 */
export function isPageVisibleOnSurface(config: PageSurfaceConfig, surface: SurfaceDeclaration): boolean {
  if (config.surfaces) {
    return config.surfaces.includes(surface.id);
  }
  if (config.requiredCapabilities) {
    return config.requiredCapabilities.every((cap) => surface.capabilities.includes(cap));
  }
  return true;
}

// =============================================================================
// Page Bus Schemas
// =============================================================================

/**
 * Runtime schema for UI navigation levels.
 *
 * The concrete level set is extensible through `UiNavigationLevelMap`
 * declaration merging, so runtime validation can only assert the shared
 * invariant: levels are non-empty string identifiers.
 */
const UiNavigationLevelSchema = z.custom<UiNavigationLevel>(
  (value) => typeof value === 'string' && value.length > 0,
  'UI navigation level must be a non-empty string',
);

/**
 * Zod schema for page metadata returned by bus queries.
 * No React types — safe for server-side consumption.
 */
const PageMetadataSchema = z.object({
  /** Unique page identifier. */
  id: z.string(),
  /** Human-readable page name. */
  name: z.string(),
  /** Optional page description. */
  description: z.string().optional(),
  /** Navigation mode: switch replaces current page; peek, cover, and sheet open overlays. */
  mode: z.enum(['switch', 'peek', 'cover', 'sheet']),
  /** Required UI navigation level for page availability. */
  level: UiNavigationLevelSchema,
  /**
   * Surfaces where this page is available.
   * - Omitted or `'all'`: available on every surface (backward-compatible default).
   * - Array of surface types: restricted to listed surfaces only.
   */
  surfaces: z.union([z.literal('all'), z.array(SurfaceIdSchema)]).optional(),
});

/**
 * Lightweight page metadata — no React types, server-safe.
 * Contains page configuration without React-specific implementation details.
 */
export type PageMetadata = z.infer<typeof PageMetadataSchema>;

/**
 * Page domain schemas.
 *
 * Subjects for page system bus communication.
 * Each key becomes a subject identifier as: `pages.{key}`
 */
export const PageSchemas = {
  /**
   * List all available pages.
   * RPC: Query for registered page metadata (used by slash command, navigation, etc.)
   */
  list: {
    request: z.object({
      /** Optional surface filter. When set, only pages available on this surface are returned. */
      surface: SurfaceIdSchema.optional(),
    }),
    response: z.object({
      /** Array of available page metadata. */
      pages: z.array(PageMetadataSchema),
    }),
  },
} as const satisfies SchemaRecord;
