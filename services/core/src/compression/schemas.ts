import { z } from 'zod';

/**
 * Bug entry extracted from conversation.
 */
export const BugEntrySchema = z.object({
  issue: z.string(),
  location: z.string(),
  impact: z.string(),
});
export type BugEntry = z.infer<typeof BugEntrySchema>;

/**
 * Todo entry extracted from conversation.
 */
export const TodoEntrySchema = z.object({
  issue: z.string(),
  location: z.string(),
  priority: z.enum(['high', 'medium', 'low']).optional(),
});
export type TodoEntry = z.infer<typeof TodoEntrySchema>;

/**
 * Technical details extracted from conversation.
 */
export const TechnicalDetailsSchema = z.object({
  files: z.array(z.string()),
  schemas: z.record(z.string(), z.unknown()),
  apis: z.array(z.string()),
  config: z.record(z.string(), z.string()),
});
export type TechnicalDetails = z.infer<typeof TechnicalDetailsSchema>;

/**
 * Full extracted context from compression.
 * This is the structured JSON that replaces raw conversation.
 */
export const ExtractedContextSchema = z.object({
  /** Completed work with resolution details */
  resolved_items: z.array(z.string()),
  /** Known bugs discovered during session */
  known_bugs: z.array(BugEntrySchema),
  /** Remaining todos */
  todos: z.array(TodoEntrySchema),
  /** Architectural decisions with reasoning */
  key_decisions_and_rationale: z.array(z.string()),
  /** Technical details: files, schemas, APIs, config */
  technical_details: TechnicalDetailsSchema,
  /** Constraints and requirements */
  constraints_and_requirements: z.array(z.string()),
  /** One paragraph summary of current state */
  current_state: z.string(),
  /** Future work items */
  roadmap: z.array(z.string()),
  /** Key data movement patterns */
  data_flows: z.array(z.string()),
  /** Component interactions: component to description mapping */
  component_interactions: z.record(z.string(), z.string()),
  /** Key files: filepath to description mapping */
  key_files: z.record(z.string(), z.string()),
  /** Quick reference hints */
  helpful_hint: z.array(z.string()),
});
export type ExtractedContext = z.infer<typeof ExtractedContextSchema>;

/**
 * Compression event for audit trail.
 */
export const CompressionEventSchema = z.object({
  timestamp: z.number(),
  type: z.enum(['full', 'incremental', 'rehydrate']),
  sourceTokens: z.number(),
  resultTokens: z.number(),
  model: z.string(),
  promptVersion: z.string(),
  /** Depth of compression (0 = first, increments on each compression) */
  depth: z.number(),
});
export type CompressionEvent = z.infer<typeof CompressionEventSchema>;

/**
 * Request to compress a session.
 */
export const CompressRequestSchema = z.object({
  sessionId: z.string(),
  /** Optional: specific turn to compress up to (default: all) */
  upToTurnId: z.string().optional(),
});
export type CompressRequest = z.infer<typeof CompressRequestSchema>;

/**
 * Response after compression completes.
 */
export const CompressResponseSchema = z.object({
  sessionId: z.string(),
  extractedContext: ExtractedContextSchema,
  compressionEvent: CompressionEventSchema,
  /** New token count after compression */
  newTokenCount: z.number(),
});
export type CompressResponse = z.infer<typeof CompressResponseSchema>;

/**
 * Bus subject schemas for compression.
 */
export const CompressionSchemas = {
  /**
   * Request compression of a session.
   * Subject: compression.compress
   */
  compress: {
    request: CompressRequestSchema,
    response: CompressResponseSchema,
  },

  /**
   * Get compression history for a session.
   * Subject: compression.getHistory
   */
  getHistory: {
    request: z.object({ sessionId: z.string() }),
    response: z.object({
      events: z.array(CompressionEventSchema),
    }),
  },
};
