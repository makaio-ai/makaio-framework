/**
 * Preferences bus schemas — pure Zod, no side effects.
 *
 * Defines schemas for preference key components, preference items, and
 * all preference management bus subjects.
 *
 * Import this module when you only need types or validation shapes without
 * registering the namespace on the bus. To register the namespace locally,
 * import `./storage-namespace` instead; package consumers can use
 * `@makaio/services-core/preferences`.
 * @packageDocumentation
 */

import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';
import { JsonValueSchema } from '@makaio/contracts';

// --- Key and Item Schemas ---

/**
 * Schema for preference key components.
 * Keys uniquely identify a preference within a scope/context.
 */
export const PreferenceKeySchema = z.object({
  /** Surface isolation (SEAM: undefined = all surfaces in Phase 1) */
  surface: z.enum(['ui', 'app']).optional(),
  /** Ownership scope: 'global' or projectId */
  scope: z.string(),
  /** Focus context for layout (SEAM: used for widget layouts) */
  context: z.string().optional(),
  /** Viewport breakpoint (SEAM: unused in Phase 1) */
  viewport: z.enum(['desktop', 'tablet', 'mobile']).optional(),
});

export type PreferenceKey = z.infer<typeof PreferenceKeySchema>;

/** Preferences persist through JSON-backed storage, so values must stay JSON-safe. */
export const PreferenceValueSchema: z.ZodType<unknown> = JsonValueSchema;

/**
 * Schema for a stored preference item.
 */
export const PreferenceItemSchema = z.object({
  key: PreferenceKeySchema,
  category: z.string(),
  value: PreferenceValueSchema,
  updatedAt: z.number(),
});

export type PreferenceItem = z.infer<typeof PreferenceItemSchema>;

// --- Bus Subject Schemas ---

/**
 * Preferences domain schemas.
 *
 * Subjects for preference management via bus communication.
 * Each key becomes a subject identifier as: `preferences.{key}`
 */
export const PreferencesSchemas = {
  /**
   * Get a preference value.
   *
   * Subject: `preferences.get`
   * Type: Request (RPC)
   * @returns The stored value or null if not found
   */
  get: {
    request: z.object({
      /** Preference key identifying the preference */
      key: PreferenceKeySchema,
      /** Category of the preference (e.g., 'layout', 'theme') */
      category: z.string(),
    }),
    response: z.object({
      /** The stored value, or null if not found */
      value: PreferenceValueSchema.nullable(),
    }),
  },

  /**
   * Set a preference value.
   *
   * Subject: `preferences.set`
   * Type: Request (RPC)
   */
  set: {
    request: z.object({
      /** Preference key identifying the preference */
      key: PreferenceKeySchema,
      /** Category of the preference (e.g., 'layout', 'theme') */
      category: z.string(),
      /** Value to store */
      value: PreferenceValueSchema,
    }),
    response: z.object({
      /** Whether the operation succeeded */
      success: z.boolean(),
    }),
  },

  /**
   * Delete a preference.
   *
   * Subject: `preferences.delete`
   * Type: Request (RPC)
   */
  delete: {
    request: z.object({
      /** Preference key identifying the preference */
      key: PreferenceKeySchema,
      /** Category of the preference */
      category: z.string(),
    }),
    response: z.object({
      /** Whether the operation succeeded */
      success: z.boolean(),
    }),
  },

  /**
   * List preferences matching criteria.
   *
   * Subject: `preferences.list`
   * Type: Request (RPC)
   */
  list: {
    request: z.object({
      /** Partial key to filter by */
      key: PreferenceKeySchema.partial().optional(),
      /** Category to filter by */
      category: z.string().optional(),
    }),
    response: z.object({
      items: z.array(PreferenceItemSchema),
    }),
  },
} satisfies SchemaRecord;
