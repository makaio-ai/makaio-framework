import { z } from 'zod';

// ─────────────────────────────────────────────────────────────
// Context Source (Pull Pipeline)
// ─────────────────────────────────────────────────────────────

/**
 * Artifact-query context source — resolves context from the artifact system.
 */
export const ArtifactQuerySourceSchema = z.object({
  type: z.literal('artifact-query'),
  /** Artifact filter (type, metadata fields, etc.). */
  filter: z.record(z.string(), z.unknown()),
  /** Selection mode: 'latest' returns the most recent match, 'all' returns all matches. */
  select: z.enum(['latest', 'all']),
  /** When true, missing results do not fail the context resolution. */
  optional: z.boolean().optional(),
});

/**
 * Bus-request context source — resolves context via an arbitrary bus RPC.
 */
export const BusRequestSourceSchema = z.object({
  type: z.literal('bus-request'),
  /** Bus subject to request. */
  subject: z.string().min(1),
  /** Request payload. */
  payload: z.record(z.string(), z.unknown()).optional(),
  /** When true, missing results do not fail the context resolution. */
  optional: z.boolean().optional(),
});

/**
 * Discriminated union of context source types.
 *
 * Each source defines WHERE to read context from. The ContextResolver
 * behind the bus RPC handles HOW.
 */
export const ContextSourceSchema = z.discriminatedUnion('type', [ArtifactQuerySourceSchema, BusRequestSourceSchema]);

export type ContextSource = z.infer<typeof ContextSourceSchema>;

// ─────────────────────────────────────────────────────────────
// Context Publish Target (Push Pipeline)
// ─────────────────────────────────────────────────────────────

/**
 * Artifact publish target — persists step output as an artifact.
 */
export const ArtifactPublishTargetSchema = z.object({
  type: z.literal('artifact'),
  /** Artifact type string (e.g., 'station-output', 'station-feedback'). */
  artifactType: z.string().min(1),
  /** Artifact scope level. Product domains use `external` metadata instead of framework-owned names. */
  scope: z.enum(['global', 'workspace', 'worktree', 'session', 'external']),
  /** Additional metadata to attach to the artifact. */
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Bus-event publish target — emits step output as a bus event.
 */
export const BusEventPublishTargetSchema = z.object({
  type: z.literal('bus-event'),
  /** Bus subject to emit on. */
  subject: z.string().min(1),
  /** Additional payload fields merged with the step output. */
  payload: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Discriminated union of context publish target types.
 *
 * Each target defines WHERE to write output. The ContextPublisher
 * behind the bus handles HOW. Multiple targets can be configured
 * to write to several channels simultaneously.
 */
export const ContextPublishTargetSchema = z.discriminatedUnion('type', [
  ArtifactPublishTargetSchema,
  BusEventPublishTargetSchema,
]);

export type ContextPublishTarget = z.infer<typeof ContextPublishTargetSchema>;

// ─────────────────────────────────────────────────────────────
// Context Bundle (resolved, ready for prompt injection)
// ─────────────────────────────────────────────────────────────

/**
 * A single resolved context entry from one source.
 */
export const ResolvedContextEntrySchema = z.object({
  /** Resolved content (typically markdown or JSON string). */
  content: z.string(),
  /** Source metadata carried through for traceability. */
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type ResolvedContextEntry = z.infer<typeof ResolvedContextEntrySchema>;

/**
 * Bundle of resolved context entries, keyed by source identifier.
 *
 * Produced by the ContextResolver after evaluating all configured sources.
 * Consumed by the prompt interpolation engine to inject context into
 * the agent step's prompt template.
 */
export const ContextBundleSchema = z.object({
  /** Resolved context entries keyed by a stable source identifier. */
  sources: z.record(z.string(), ResolvedContextEntrySchema),
});

export type ContextBundle = z.infer<typeof ContextBundleSchema>;
