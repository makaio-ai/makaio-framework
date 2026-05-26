import { z } from 'zod';
import { createBusNamespace, type SchemaRecord } from '@makaio/core';
import { ArtifactChangesSchema, ArtifactCreateBodySchema, ArtifactFilterSchema, ArtifactSchema } from './schemas.js';

/**
 * Framework-level artifact bus schemas.
 *
 * Defines lifecycle events and core RPCs for hosts that opt into the framework
 * artifact contract. Product hosts that still ship a wider `artifact`
 * namespace should register that product namespace instead of registering both.
 */
export const ArtifactSchemas = {
  /** Emitted when a new artifact is created. */
  created: z.object({
    artifact: ArtifactSchema,
  }),

  /** Emitted when an existing artifact is modified. */
  updated: z.object({
    artifact: ArtifactSchema,
    changes: ArtifactChangesSchema,
  }),

  /** Emitted when an artifact is deleted. */
  deleted: z.object({
    id: z.string(),
    sessionId: z.string().optional(),
  }),

  /** Create a new artifact (RPC). */
  create: {
    request: z.discriminatedUnion('scope', [
      z.object({ scope: z.literal('session'), sessionId: z.string().min(1) }).merge(ArtifactCreateBodySchema),
      z.object({ scope: z.literal('global') }).merge(ArtifactCreateBodySchema),
    ]),
    response: z.object({
      artifact: ArtifactSchema,
    }),
  },

  /** List artifacts (RPC). */
  list: {
    request: z.object({
      sessionId: z.string().min(1).optional(),
      filter: ArtifactFilterSchema.optional(),
    }),
    response: z.object({
      artifacts: z.array(ArtifactSchema),
    }),
  },
} satisfies SchemaRecord;

/**
 * Artifact bus namespace.
 *
 * Registers the `artifact` namespace with framework-level lifecycle events and
 * core RPCs. Keep one active owner for the `artifact` namespace in a given host;
 * current product hosts use the product artifact namespace until the migration
 * to this framework contract is complete.
 */
export const ArtifactNamespace = createBusNamespace('artifact', ArtifactSchemas);

/**
 * Typed subjects for artifact bus communication.
 *
 * Available subjects:
 * - `ArtifactSubjects.created` — artifact creation event
 * - `ArtifactSubjects.updated` — artifact update event
 * - `ArtifactSubjects.deleted` — artifact deletion event
 * - `ArtifactSubjects.create` — create artifact RPC
 * - `ArtifactSubjects.list` — list artifacts RPC
 */
export const ArtifactSubjects = ArtifactNamespace.subjects;

// Event payload types
/** Payload for artifact created event. */
export type ArtifactCreatedPayload = z.infer<typeof ArtifactSchemas.created>;

/** Payload for artifact updated event. */
export type ArtifactUpdatedPayload = z.infer<typeof ArtifactSchemas.updated>;

/** Payload for artifact deleted event. */
export type ArtifactDeletedPayload = z.infer<typeof ArtifactSchemas.deleted>;

// RPC types
/** Request payload for creating an artifact. */
export type ArtifactCreateRequest = z.infer<typeof ArtifactSchemas.create.request>;

/** Response payload for creating an artifact. */
export type ArtifactCreateResponse = z.infer<typeof ArtifactSchemas.create.response>;

/** Request payload for listing artifacts. */
export type ArtifactListRequest = z.infer<typeof ArtifactSchemas.list.request>;

/** Response payload for listing artifacts. */
export type ArtifactListResponse = z.infer<typeof ArtifactSchemas.list.response>;
