import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';
import { CredentialFreeGitRemoteSchema, CredentialFreeRelayUrlSchema } from './container-schemas.js';

// ── Shared base (embedded into each variant, not used standalone) ──

const ExecutionTargetBaseSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  /** Two-tier scope: 'default' (global) or a projectId string. */
  scope: z.string(),
  enabled: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

// ── Variant: local ──
// Agent runs as local process on developer's machine.
// CWD comes from worktree or session context — no additional config needed.

export const LocalExecutionTargetSchema = ExecutionTargetBaseSchema.extend({
  type: z.literal('local'),
});

// ── Variant: container-local ──
// Docker on developer's machine. Host worktree bind-mounted at /workspace.

export const ContainerLocalExecutionTargetSchema = ExecutionTargetBaseSchema.extend({
  type: z.literal('container-local'),
  /** Docker image. Resolved by ImageResolver if omitted. */
  image: z.string().optional(),
  /** Extra environment variables injected into the container. */
  env: z.record(z.string(), z.string()).optional(),
  /** Bus URL override for non-standard Docker networking. */
  busUrl: z.string().optional(),
});

// ── Variant: container-isolated ──
// Self-contained Docker. Clones repo + checks out branch internally.
// No host filesystem dependency. Works locally or in the cloud.

export const ContainerIsolatedExecutionTargetSchema = ExecutionTargetBaseSchema.extend({
  type: z.literal('container-isolated'),
  /** Docker image. */
  image: z.string().optional(),
  /** Extra environment variables. */
  env: z.record(z.string(), z.string()).optional(),
  /**
   * Bus connectivity mode.
   * - 'host': ws://host.docker.internal (container is on local machine)
   * - 'relay': wss://relay.makaio.dev (container is remote/cloud)
   */
  busMode: z.enum(['host', 'relay']),
  /** Relay URL override for 'relay' mode. */
  relayUrl: CredentialFreeRelayUrlSchema.optional(),
  /**
   * Git credential mode for cloning inside the container.
   * - 'token': inject GITHUB_TOKEN (or equivalent) as env var
   * - 'ssh-agent': forward SSH_AUTH_SOCK (Phase 2 — platform-dependent)
   */
  gitCredentialMode: z.enum(['token', 'ssh-agent']).default('token'),
  /** Git remote URL to clone. Defaults to origin of current project repo. */
  repoUrl: CredentialFreeGitRemoteSchema.optional(),
});

// ── Discriminated union ──

export const ExecutionTargetSchema = z.discriminatedUnion('type', [
  LocalExecutionTargetSchema,
  ContainerLocalExecutionTargetSchema,
  ContainerIsolatedExecutionTargetSchema,
]);
export type ExecutionTarget = z.infer<typeof ExecutionTargetSchema>;

/** Execution target type discriminator values. */
export const ExecutionTargetTypeSchema = z.enum(['local', 'container-local', 'container-isolated']);
export type ExecutionTargetType = z.infer<typeof ExecutionTargetTypeSchema>;

// ── Input (create/update — without auto-managed timestamps) ──

export const ExecutionTargetInputSchema = z.discriminatedUnion('type', [
  LocalExecutionTargetSchema.omit({ createdAt: true, updatedAt: true }),
  ContainerLocalExecutionTargetSchema.omit({ createdAt: true, updatedAt: true }),
  ContainerIsolatedExecutionTargetSchema.omit({ createdAt: true, updatedAt: true }),
]);
/**
 * Input type for create/update payloads.
 * Uses schema input type so callers can omit fields with defaults.
 */
export type ExecutionTargetInput = z.input<typeof ExecutionTargetInputSchema>;

// ── List query ──

/** Query parameters for listing execution targets. */
export const ExecutionTargetListQuerySchema = z.object({
  scope: z.string().optional(),
  type: ExecutionTargetTypeSchema.optional(),
});
export type ExecutionTargetListQuery = z.infer<typeof ExecutionTargetListQuerySchema>;

// ── Resolve request ──

/** Resolution request for finding the effective execution target. */
export const ExecutionTargetResolveRequestSchema = z.object({
  executionTargetId: z.string().optional(),
});
export type ExecutionTargetResolveRequest = z.infer<typeof ExecutionTargetResolveRequestSchema>;

/**
 * Execution target namespace schemas.
 */
export const ExecutionTargetSchemas = {
  get: {
    request: z.object({ id: z.string() }),
    response: z.object({ executionTarget: ExecutionTargetSchema.nullable() }),
  },
  set: {
    request: z.object({ executionTarget: ExecutionTargetInputSchema }),
    response: z.object({ id: z.string() }),
  },
  delete: {
    request: z.object({ id: z.string() }),
    response: z.object({ deleted: z.boolean() }),
  },
  list: {
    request: ExecutionTargetListQuerySchema,
    response: z.object({ executionTargets: z.array(ExecutionTargetSchema) }),
  },
  resolve: {
    request: ExecutionTargetResolveRequestSchema,
    response: z.object({ executionTarget: ExecutionTargetSchema }),
  },
  created: ExecutionTargetSchema,
  updated: ExecutionTargetSchema,
  deleted: z.object({ id: z.string() }),
} satisfies SchemaRecord;
