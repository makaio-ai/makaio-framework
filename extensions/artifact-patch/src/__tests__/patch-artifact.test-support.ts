/**
 * Shared test harness for patch-artifact tests.
 *
 * Exports the recording host, shared context, and response-validating helpers
 * used by patch-artifact.test.ts and patch-artifact.part-ids.test.ts. Each
 * test file imports these and supplies its own kind/revision fixtures.
 */
import {
  ArtifactKindRegistrationSchema,
  ArtifactPatchRequestSchema,
  ArtifactPatchResponseSchema,
  ArtifactRevisionSchema,
  type ArtifactKindRegistration,
  type ArtifactPatchRequest,
  type ArtifactPatchResponse,
  type ArtifactRevision,
} from '@makaio/contracts';
import { createMakaioContext } from '@makaio/core';
import type { ToolExecutionContext } from '@makaio/tools-core';
import { patchArtifact, type ArtifactPatchHost, type ArtifactPatchStoreRequest } from '../patch-artifact.js';

// ─── default kind fixture ─────────────────────────────────────────────────────

export const kind = ArtifactKindRegistrationSchema.parse({
  kind: 'implementation-plan',
  description: 'A plan used by patch tests.',
  schemaVersion: 2,
  category: 'commitment',
  titlePath: 'title',
  dataSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: { type: 'string' },
      summary: { type: 'string' },
      blockers: { type: 'array', items: { type: 'string' } },
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string' },
            status: { type: 'string', enum: ['open', 'in-progress', 'done'] },
            notes: { type: 'string' },
            subtasks: { type: 'array', items: { type: 'string' } },
            details: {
              type: 'object',
              additionalProperties: false,
              properties: { flag: { type: 'boolean' } },
            },
          },
          required: ['title', 'status'],
        },
      },
    },
    required: ['title', 'tasks'],
  },
});

export const BASE_DATA = {
  title: 'Patch-based revisions',
  summary: 'Send the change, not the payload.',
  blockers: ['awaiting review'],
  tasks: [
    { title: 'Declare the contract', status: 'done' },
    { title: 'Write the engine', status: 'open' },
    { title: 'Wire the facade', status: 'open' },
  ],
} as const;

/**
 * Build a stored revision of the implementation-plan fixture.
 * @param revision - Revision identifier to report.
 * @param data - Payload the revision carries.
 * @param schemaVersion - Schema version the revision is labelled with.
 * @returns A validated artifact revision.
 */
export function planRevision(
  revision: string,
  data: Record<string, unknown> = structuredClone(BASE_DATA),
  schemaVersion = 2,
): ArtifactRevision {
  return ArtifactRevisionSchema.parse({
    kind: 'implementation-plan',
    id: 'plan-1',
    revision,
    schemaVersion,
    scope: { level: 'global' },
    data,
    relations: [],
    actor: { kind: 'agent', id: 'test' },
    timestamp: 0,
  });
}

// ─── recording host ───────────────────────────────────────────────────────────

export interface RecordingHost extends ArtifactPatchHost {
  /** Payloads the host actually persisted, in order. */
  readonly stored: Record<string, unknown>[];
  /** Complete store requests the host received, in order. */
  readonly writes: ArtifactPatchStoreRequest[];
  /** Revisions the host reported as persisted, in order. */
  readonly persisted: ArtifactRevision[];
}

/**
 * Build a host serving one artifact from memory and recording every write.
 *
 * The store handler derives the returned revision from whichever `current`
 * revision the host serves, so it works for any registered kind — not only
 * `implementation-plan`.
 * @param options - Current revision, registrations, and optional failure injection.
 * @returns A recording host.
 */
export function host(
  options: {
    readonly current?: ArtifactRevision | null;
    readonly registrations?: readonly ArtifactKindRegistration[];
    readonly failResolve?: string;
    readonly failStore?: string;
    readonly storedRevision?: string;
    /** Version the host labels the stored revision with, when it ignores the request. */
    readonly storedSchemaVersion?: number;
    readonly storeConflictsWith?: string;
    readonly rejectStore?: { message: string; issues?: { path: string; reason: string }[] };
  } = {},
): RecordingHost {
  const current = options.current === undefined ? planRevision('rev-1') : options.current;
  const stored: Record<string, unknown>[] = [];
  const writes: ArtifactPatchStoreRequest[] = [];
  const persisted: ArtifactRevision[] = [];
  return {
    stored,
    writes,
    persisted,
    listKinds: async (requested) =>
      (options.registrations ?? [kind]).filter((candidate) => candidate.kind === requested),
    resolveCurrent: async () => {
      if (options.failResolve) throw new Error(options.failResolve);
      return current;
    },
    store: async (request) => {
      if (options.failStore) throw new Error(options.failStore);
      // A compliant host compares `previous.revision` while writing; this one
      // reports the refusal the same way a real compare-and-swap store would.
      if (options.storeConflictsWith) return { conflictingRevision: options.storeConflictsWith };
      // A deterministic refusal is returned, not thrown: nothing was written.
      if (options.rejectStore) return { rejection: options.rejectStore };
      writes.push(request);
      stored.push(request.data);
      // Derive the stored revision from the current one so the host works for
      // any registered kind, not only the default implementation-plan fixture.
      const revision = ArtifactRevisionSchema.parse({
        ...(current as Record<string, unknown>),
        revision: options.storedRevision ?? 'rev-2',
        data: request.data,
        schemaVersion: options.storedSchemaVersion ?? request.schemaVersion,
      });
      persisted.push(revision);
      return revision;
    },
  };
}

// ─── shared context and helpers ───────────────────────────────────────────────

export const context: ToolExecutionContext = createMakaioContext();

/**
 * Validate a request against the wire contract before executing it.
 * @param request - Request as an agent would write it.
 * @returns The parsed request.
 */
export function parseRequest(request: unknown): ArtifactPatchRequest {
  return ArtifactPatchRequestSchema.parse(request);
}

/**
 * Execute one patch and assert the response satisfies the wire contract.
 * @param request - Request as an agent would write it.
 * @param patchHost - Host serving the artifact.
 * @returns The contract-valid response.
 */
export async function patch(request: unknown, patchHost: ArtifactPatchHost = host()): Promise<ArtifactPatchResponse> {
  const response = await patchArtifact(parseRequest(request), context, patchHost);
  return ArtifactPatchResponseSchema.parse(response);
}

/**
 * Build a request body around one patch document targeting the default
 * implementation-plan fixture.
 * @param document - Patch instructions.
 * @param overrides - Request fields to replace.
 * @returns A complete request body.
 */
export function request(document: unknown, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ref: { kind: 'implementation-plan', id: 'plan-1' },
    baseRevision: 'rev-1',
    patch: document,
    ...overrides,
  };
}

// Re-export ArtifactPatchHost so test files can type inline host literals
// without a separate @makaio/contracts import.
export type { ArtifactPatchHost };
