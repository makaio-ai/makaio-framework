/**
 * Types and schemas for OpenCode log import.
 *
 * OpenCode stores logs in separate JSON files under ~/.local/share/opencode/storage/:
 * - Session metadata: `session/{project-hash}/{session-id}.json`
 * - Message metadata: `message/{session-id}/{message-id}.json`
 * - Message parts: `part/{message-id}/{part-id}.json`
 *
 * Schema verified against actual OpenCode v1.1.x logs (2026-01-22).
 * @packageDocumentation
 */

import type { TurnTrackerSerializedState } from '@makaio/ai-adapters-core';
import { z } from 'zod';

/**
 * Declaration merging to extend ExternalToolIdentifiers with OpenCode adapter name.
 */
declare module '@makaio/ai-adapters-core' {
  interface ExternalToolIdentifiers {
    'plugin:opencode': import('@makaio/ai-adapters-core').ExternalToolMeta;
  }
}

/**
 * Resumable import state for OpenCode log importer.
 *
 * Tracks the state needed to resume incremental imports across chunks.
 * @see {@link TurnTrackerSerializedState} - Turn tracker state for turn boundary detection
 */
export interface OpenCodeImportState {
  /** Index of last processed message in messages array (for incremental imports) */
  lastProcessedIndex: number;
  /** ID of the last user message processed (for turn correlation) */
  lastUserMessageId?: string;
  /** Serialized turn tracker state */
  turnTrackerState: TurnTrackerSerializedState;
}

/**
 * Timestamp metadata used across OpenCode entities.
 * Some entities have `completed` (messages) while others have `updated` (sessions).
 */
export const OpenCodeTimeSchema = z.object({
  created: z.number(),
  updated: z.number().optional(),
  completed: z.number().optional(),
});

export type OpenCodeTime = z.infer<typeof OpenCodeTimeSchema>;

/**
 * Time range for parts (start/end timestamps).
 */
export const OpenCodeTimeRangeSchema = z.object({
  start: z.number(),
  end: z.number(),
});

export type OpenCodeTimeRange = z.infer<typeof OpenCodeTimeRangeSchema>;

/**
 * Summary metadata for sessions.
 */
export const OpenCodeSummarySchema = z.object({
  additions: z.number(),
  deletions: z.number(),
  files: z.number(),
});

export type OpenCodeSummary = z.infer<typeof OpenCodeSummarySchema>;

/**
 * Message summary metadata (user messages).
 */
export const OpenCodeMessageSummarySchema = z.object({
  title: z.string(),
  diffs: z.array(z.unknown()),
});

export type OpenCodeMessageSummary = z.infer<typeof OpenCodeMessageSummarySchema>;

/**
 * Model metadata in messages (nested form for user messages).
 */
export const OpenCodeModelSchema = z.object({
  providerID: z.string(),
  modelID: z.string(),
});

export type OpenCodeModel = z.infer<typeof OpenCodeModelSchema>;

/**
 * Path information for assistant messages.
 */
export const OpenCodePathSchema = z.object({
  cwd: z.string(),
  root: z.string(),
});

export type OpenCodePath = z.infer<typeof OpenCodePathSchema>;

/**
 * Token metrics structure.
 * Used in both messages and step-finish parts.
 */
export const OpenCodeTokensSchema = z.object({
  input: z.number(),
  output: z.number(),
  reasoning: z.number().optional(),
  cache: z
    .object({
      read: z.number(),
      write: z.number(),
    })
    .optional(),
});

export type OpenCodeTokens = z.infer<typeof OpenCodeTokensSchema>;

/**
 * Tool state in tool parts.
 */
export const OpenCodeToolStateSchema = z.object({
  status: z.enum(['pending', 'running', 'completed', 'error']),
  input: z.record(z.string(), z.unknown()),
  output: z.unknown().optional(),
  title: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  time: OpenCodeTimeRangeSchema.optional(),
});

export type OpenCodeToolState = z.infer<typeof OpenCodeToolStateSchema>;

/**
 * Nested token and cost metrics found in some OpenCode step-finish parts.
 * The flat variant uses top-level `tokens` / `cost` on the part itself.
 */
export const OpenCodeStepMetricsSchema = z.object({
  tokens: z
    .object({
      input: z.number(),
      output: z.number(),
      total: z.number(),
    })
    .optional(),
  cost: z
    .object({
      input: z.number(),
      output: z.number(),
      total: z.number(),
    })
    .optional(),
});

export type OpenCodeStepMetrics = z.infer<typeof OpenCodeStepMetricsSchema>;

/**
 * Base fields common to all part types.
 */
const OpenCodePartBaseSchema = z.object({
  id: z.string(),
  sessionID: z.string(),
  messageID: z.string(),
});

/**
 * Text part schema.
 */
export const OpenCodeTextPartSchema = OpenCodePartBaseSchema.extend({
  type: z.literal('text'),
  text: z.string(),
  time: OpenCodeTimeRangeSchema.optional(),
});

/**
 * Reasoning part schema (for models that expose reasoning/thinking).
 */
export const OpenCodeReasoningPartSchema = OpenCodePartBaseSchema.extend({
  type: z.literal('reasoning'),
  text: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  time: OpenCodeTimeRangeSchema.optional(),
});

/**
 * Tool part schema.
 */
export const OpenCodeToolPartSchema = OpenCodePartBaseSchema.extend({
  type: z.literal('tool'),
  callID: z.string(),
  tool: z.string(),
  state: OpenCodeToolStateSchema,
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Step-start part schema.
 */
export const OpenCodeStepStartPartSchema = OpenCodePartBaseSchema.extend({
  type: z.literal('step-start'),
  snapshot: z.string().optional(),
});

/**
 * Step-finish part schema.
 * Tokens and cost appear either at top level or nested inside a `metrics` object.
 */
export const OpenCodeStepFinishPartSchema = OpenCodePartBaseSchema.extend({
  type: z.literal('step-finish'),
  reason: z.string().optional(),
  snapshot: z.string().optional(),
  cost: z.number().optional(),
  tokens: OpenCodeTokensSchema.optional(),
  /** Nested variant — some logs use this instead of top-level tokens/cost */
  metrics: OpenCodeStepMetricsSchema.optional(),
});

/**
 * Discriminated union of all part types.
 */
export const OpenCodePartSchema = z.discriminatedUnion('type', [
  OpenCodeTextPartSchema,
  OpenCodeReasoningPartSchema,
  OpenCodeToolPartSchema,
  OpenCodeStepStartPartSchema,
  OpenCodeStepFinishPartSchema,
]);

export type OpenCodePart = z.infer<typeof OpenCodePartSchema>;
export type OpenCodeTextPart = z.infer<typeof OpenCodeTextPartSchema>;
export type OpenCodeReasoningPart = z.infer<typeof OpenCodeReasoningPartSchema>;
export type OpenCodeToolPart = z.infer<typeof OpenCodeToolPartSchema>;
export type OpenCodeStepStartPart = z.infer<typeof OpenCodeStepStartPartSchema>;
export type OpenCodeStepFinishPart = z.infer<typeof OpenCodeStepFinishPartSchema>;

/**
 * Base message fields common to both user and assistant messages.
 */
const OpenCodeMessageBaseSchema = z.object({
  id: z.string(),
  sessionID: z.string(),
  role: z.enum(['user', 'assistant']),
  time: OpenCodeTimeSchema,
  agent: z.string().optional(),
});

/**
 * User message specific fields.
 */
export const OpenCodeUserMessageSchema = OpenCodeMessageBaseSchema.extend({
  role: z.literal('user'),
  /** Nested model info (user messages) */
  model: OpenCodeModelSchema.optional(),
  /** Message summary with title */
  summary: OpenCodeMessageSummarySchema.optional(),
  /** Model variant (e.g., 'medium') */
  variant: z.string().optional(),
});

/**
 * Assistant message specific fields.
 */
export const OpenCodeAssistantMessageSchema = OpenCodeMessageBaseSchema.extend({
  role: z.literal('assistant'),
  /** Parent message ID (assistant responses link to user message) */
  parentID: z.string().optional(),
  /** Model ID at top level (assistant messages) */
  modelID: z.string().optional(),
  /** Provider ID at top level (assistant messages) */
  providerID: z.string().optional(),
  /** Agent mode (e.g., 'build') */
  mode: z.string().optional(),
  /** Working directory info */
  path: OpenCodePathSchema.optional(),
  /** Total cost for this message */
  cost: z.number().optional(),
  /** Token usage for this message */
  tokens: OpenCodeTokensSchema.optional(),
  /** Finish reason (e.g., 'tool-calls', 'stop') */
  finish: z.string().optional(),
});

/**
 * Message metadata stored in message/\{session-id\}/\{message-id\}.json.
 * Union type that accepts both user and assistant message formats.
 */
export const OpenCodeMessageSchema = z.union([OpenCodeUserMessageSchema, OpenCodeAssistantMessageSchema]);

export type OpenCodeMessage = z.infer<typeof OpenCodeMessageSchema>;
export type OpenCodeUserMessage = z.infer<typeof OpenCodeUserMessageSchema>;
export type OpenCodeAssistantMessage = z.infer<typeof OpenCodeAssistantMessageSchema>;

/**
 * Session metadata stored in session/\{project-hash\}/\{session-id\}.json.
 */
export const OpenCodeSessionSchema = z.object({
  id: z.string(),
  slug: z.string(),
  version: z.string(),
  projectID: z.string(),
  directory: z.string(),
  title: z.string(),
  time: OpenCodeTimeSchema,
  summary: OpenCodeSummarySchema.optional(),
});

export type OpenCodeSession = z.infer<typeof OpenCodeSessionSchema>;

/**
 * Combined session log with aggregated messages and parts.
 *
 * This is the normalized structure we build from session/message/part files.
 */
export interface OpenCodeSessionLog {
  session: OpenCodeSession;
  messages: OpenCodeMessage[];
  parts: Map<string, OpenCodePart[]>; // messageId -> parts
  /**
   * Path to the session.json file this log was loaded from.
   * Used to derive the storage root for loading messages/parts.
   * Example: ~/.local/share/opencode/project/\{slug\}/storage/session/\{uuid\}/session.json
   */
  sourceFilePath?: string;
}

/**
 * Configuration for the OpenCode log importer.
 */
export interface OpenCodeLogImporterConfig {
  /** Unique identifier for the adapter instance */
  adapterId: string;

  /** Display name for the adapter */
  adapterName: string;

  /**
   * Optional function to check if a session is already managed by Makaio.
   *
   * Used to skip importing sessions that are already tracked in the system.
   * @param sessionId - The session ID to check
   * @returns Promise resolving to true if session is managed, false otherwise
   */
  checkMakaioManaged?: (sessionId: string) => Promise<boolean>;
}
