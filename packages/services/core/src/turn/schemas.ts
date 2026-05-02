/**
 * Turn storage bus schemas — pure Zod, no side effects.
 *
 * Defines the Zod schemas for turn lifecycle management bus subjects.
 * A turn represents a user message and all agent responses to it.
 *
 * Import this module when you only need types or validation shapes without
 * registering the namespace on the bus. To register the namespace, import
 * `./register` instead.
 * @packageDocumentation
 */

import { z } from 'zod';
import { TurnSchema, TurnStatusSchema, TurnUsageSchema } from '@makaio/contracts';
import type { SchemaRecord } from '@makaio/core';

/**
 * Zod schemas for all turn storage bus subjects.
 *
 * Each entry becomes a subject identifier as `storage:turn.<key>`.
 */
export const TurnStorageSchemas = {
  /**
   * Create a new turn.
   *
   * Subject: `storage:turn.create`
   * Type: Request (RPC)
   */
  create: {
    request: z.object({
      sessionId: z.string(),
      turnId: z.string().optional(),
    }),
    response: z.object({
      turn: TurnSchema,
    }),
  },

  /**
   * Complete a turn (mark as completed or error).
   *
   * Subject: `storage:turn.complete`
   * Type: Request (RPC)
   */
  complete: {
    request: z.object({
      turnId: z.string(),
      status: z.enum(['completed', 'error']),
      expectedStatus: TurnStatusSchema.optional(),
      error: z.string().optional(),
      usage: TurnUsageSchema.optional(),
    }),
    response: z.object({
      turn: TurnSchema,
      transitioned: z.boolean(),
    }),
  },

  /**
   * Store or update a turn with full data.
   *
   * Subject: `storage:turn.set`
   * Type: Request (RPC)
   *
   * Used for imports and backfills that need to preserve timestamps/usage.
   */
  set: {
    request: z.object({
      turn: TurnSchema,
    }),
    response: z.object({
      turn: TurnSchema,
    }),
  },

  /**
   * Get a turn by ID.
   *
   * Subject: `storage:turn.get`
   * Type: Request (RPC)
   */
  get: {
    request: z.object({
      turnId: z.string(),
    }),
    response: z.object({
      turn: TurnSchema.nullable(),
    }),
  },

  /**
   * List turns for a session.
   *
   * Subject: `storage:turn.getBySession`
   * Type: Request (RPC)
   */
  getBySession: {
    request: z.object({
      sessionId: z.string(),
      limit: z.number().int().min(1).optional(),
      status: TurnStatusSchema.optional(),
    }),
    response: z.object({
      turns: z.array(TurnSchema),
    }),
  },

  /**
   * Get the active turn for a session (if any).
   *
   * Subject: `storage:turn.getActive`
   * Type: Request (RPC)
   */
  getActive: {
    request: z.object({
      sessionId: z.string(),
    }),
    response: z.object({
      turn: TurnSchema.nullable(),
    }),
  },

  /**
   * List all active turns across all sessions.
   *
   * Used at startup to identify orphaned turns left active after a process crash.
   * No session filter — returns every turn with status `'active'`.
   *
   * Subject: `storage:turn.listActive`
   * Type: Request (RPC)
   */
  listActive: {
    request: z.object({}),
    response: z.object({
      turns: z.array(TurnSchema),
    }),
  },
} satisfies SchemaRecord;
