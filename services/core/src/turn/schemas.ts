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
import { TurnInitiatorSchema, TurnSchema, TurnStatusSchema, TurnUsageSchema } from '@makaio/contracts';
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
      initiator: TurnInitiatorSchema.optional(),
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
      /** Replacement usage snapshot. `null` explicitly clears stale usage. */
      usage: TurnUsageSchema.nullable().optional(),
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
   * Idempotent upsert of an externally-completed turn, keyed on
   * `(sessionId, turnAnchorId)`.
   *
   * The anchor is a content-derived idempotency key (the adapterMessageId of
   * the turn-start user message in an imported transcript). The first insert
   * assigns `turnNumber` atomically (MAX+1 per session); a conflicting
   * re-ingestion of the same anchor updates completion fields only and NEVER
   * changes `turnId`, `turnNumber`, or `startedAt` — `(sessionId, turnNumber)`
   * is a stable downstream watermark, so re-parsing the same transcript
   * (including compaction re-reads from byte 0) must never renumber or
   * duplicate existing turns.
   *
   * `created` in the response distinguishes first ingestion (`true`) from an
   * anchor-conflicting re-ingestion (`false`), letting callers gate
   * exactly-once side effects (event emission) on it.
   *
   * Subject: `storage:turn.ingestCompleted`
   * Type: Request (RPC)
   */
  ingestCompleted: {
    request: z.object({
      sessionId: z.string(),
      turnAnchorId: z.string().min(1),
      startedAt: z.number(),
      completedAt: z.number(),
      status: z.enum(['completed', 'error']),
      error: z.string().optional(),
      usage: TurnUsageSchema.optional(),
      initiator: TurnInitiatorSchema.optional(),
    }),
    response: z.object({
      turn: TurnSchema,
      created: z.boolean(),
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
