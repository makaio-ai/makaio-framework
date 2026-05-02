import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';
import { ActionCategorySchema } from './types.js';

/**
 * UI-safe subset of SessionEditorAction.
 *
 * Represents an action that can be executed in the session editor pipeline,
 * without exposing the execute method or runtime-specific details.
 */
export const ActionSummarySchema = z.object({
  /** Unique identifier */
  id: z.string(),
  /** Display label */
  label: z.string(),
  /** Description shown in UI */
  description: z.string(),
  /** Category for grouping in UI */
  category: ActionCategorySchema,
});

export type ActionSummary = z.infer<typeof ActionSummarySchema>;

/**
 * Session editor domain schemas.
 *
 * Subjects for session editor actions and pipeline operations via bus communication.
 * Each key becomes a subject identifier as: `session-editor.{key}`
 * @example
 * ```typescript
 * // List available actions
 * const { actions } = await bus.request(SessionEditorSubjects.listActions, {});
 * ```
 */
export const SessionEditorSchemas = {
  /**
   * List all registered session editor actions.
   *
   * Subject: `session-editor.listActions`
   * Type: Request (RPC)
   *
   * Returns available actions for the session editor pipeline UI.
   * Actions are grouped by category (compression, extraction, transformation).
   * @example
   * ```typescript
   * const { actions } = await bus.request(SessionEditorSubjects.listActions, {});
   * const compressionActions = actions.filter(a => a.category === 'compression');
   * ```
   */
  listActions: {
    request: z.object({}),
    response: z.object({
      /** Array of available actions */
      actions: z.array(ActionSummarySchema),
    }),
  },
} satisfies SchemaRecord;
