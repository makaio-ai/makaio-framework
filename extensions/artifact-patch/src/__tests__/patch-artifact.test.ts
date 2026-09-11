import { describe, expect, it } from 'vitest';
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
import type { ToolExecutionContext, Toolset } from '@makaio/tools-core';
import {
  patchArtifact,
  executePatchArtifact,
  type ArtifactPatchHost,
  type ArtifactPatchStoreRequest,
} from '../patch-artifact.js';
import { artifactPatchPackage, createArtifactPatchPackage } from '../index.js';

const kind = ArtifactKindRegistrationSchema.parse({
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

const BASE_DATA = {
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
 * Build a stored revision of the plan fixture.
 * @param revision - Revision identifier to report.
 * @param data - Payload the revision carries.
 * @returns A validated artifact revision.
 */
function planRevision(revision: string, data: Record<string, unknown> = structuredClone(BASE_DATA)): ArtifactRevision {
  return ArtifactRevisionSchema.parse({
    kind: 'implementation-plan',
    id: 'plan-1',
    revision,
    schemaVersion: 2,
    scope: { level: 'global' },
    data,
    relations: [],
    actor: { kind: 'agent', id: 'test' },
    timestamp: 0,
  });
}

interface RecordingHost extends ArtifactPatchHost {
  /** Payloads the host actually persisted, in order. */
  readonly stored: Record<string, unknown>[];
  /** Complete store requests the host received, in order. */
  readonly writes: ArtifactPatchStoreRequest[];
}

/**
 * Build a host serving one artifact from memory and recording every write.
 * @param options - Current revision, registrations, and optional failure injection.
 * @returns A recording host.
 */
function host(
  options: {
    readonly current?: ArtifactRevision | null;
    readonly registrations?: readonly ArtifactKindRegistration[];
    readonly failResolve?: string;
    readonly failStore?: string;
    readonly storedRevision?: string;
    readonly storeConflictsWith?: string;
  } = {},
): RecordingHost {
  const current = options.current === undefined ? planRevision('rev-1') : options.current;
  const stored: Record<string, unknown>[] = [];
  const writes: ArtifactPatchStoreRequest[] = [];
  return {
    stored,
    writes,
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
      writes.push(request);
      stored.push(request.data);
      return planRevision(options.storedRevision ?? 'rev-2', request.data);
    },
  };
}

const context: ToolExecutionContext = createMakaioContext();

/**
 * Validate a request against the wire contract before executing it.
 * @param request - Request as an agent would write it.
 * @returns The parsed request.
 */
function parseRequest(request: unknown): ArtifactPatchRequest {
  return ArtifactPatchRequestSchema.parse(request);
}

/**
 * Execute one patch and assert the response satisfies the wire contract.
 * @param request - Request as an agent would write it.
 * @param patchHost - Host serving the artifact.
 * @returns The contract-valid response.
 */
async function patch(request: unknown, patchHost: ArtifactPatchHost = host()): Promise<ArtifactPatchResponse> {
  const response = await patchArtifact(parseRequest(request), context, patchHost);
  return ArtifactPatchResponseSchema.parse(response);
}

/**
 * Build a request body around one patch document.
 * @param document - Patch instructions.
 * @param overrides - Request fields to replace.
 * @returns A complete request body.
 */
function request(document: unknown, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ref: { kind: 'implementation-plan', id: 'plan-1' },
    baseRevision: 'rev-1',
    patch: document,
    ...overrides,
  };
}

const CHANGE_ENTRY = {
  $set: { 'tasks.$[entry].status': 'done' },
  arrayFilters: [{ 'entry.title': 'Write the engine' }],
};

/**
 * Two entries a status filter selects together, of which only the first carries
 * the nested state a deeper path addresses.
 */
const UNEVEN_TASKS = {
  title: 'Patch-based revisions',
  tasks: [
    { title: 'Declare the contract', status: 'open', details: { flag: false }, subtasks: ['draft the schema'] },
    { title: 'Write the engine', status: 'open', subtasks: [] },
  ],
};

/** A filter selecting both entries of the uneven fixture. */
const OPEN_ENTRIES = [{ 'entry.status': 'open' }];

describe('patch request contract', () => {
  it('rejects an operator outside the declared subset', () => {
    const result = ArtifactPatchRequestSchema.safeParse(request({ $inc: { count: 1 } }));

    expect(result.success).toBe(false);
  });

  it('rejects a patch with no instruction at all', () => {
    const result = ArtifactPatchRequestSchema.safeParse(request({}));

    expect(result.success).toBe(false);
  });

  it('rejects a placeholder without a matching array filter', () => {
    const result = ArtifactPatchRequestSchema.safeParse(request({ $set: { 'tasks.$[entry].status': 'done' } }));

    expect(result.success).toBe(false);
  });

  it('rejects an array filter that no path uses', () => {
    const result = ArtifactPatchRequestSchema.safeParse(
      request({ $set: { summary: 'x' }, arrayFilters: [{ 'entry.title': 'Write the engine' }] }),
    );

    expect(result.success).toBe(false);
  });

  it('rejects an array filter binding more than one placeholder', () => {
    const result = ArtifactPatchRequestSchema.safeParse(
      request({
        $set: { 'tasks.$[entry].status': 'done' },
        arrayFilters: [{ 'entry.title': 'Write the engine', 'other.title': 'x' }],
      }),
    );

    expect(result.success).toBe(false);
  });
});

describe('changing a scalar', () => {
  it('replaces a declared scalar and persists one new revision', async () => {
    const target = host();

    const response = await patch(request({ $set: { summary: 'Patch semantics.' } }), target);

    expect(response).toMatchObject({
      ok: true,
      dryRun: false,
      base: { refClass: 'artifact', kind: 'implementation-plan', id: 'plan-1', revision: 'rev-1' },
      artifact: { revision: 'rev-2' },
      operations: [{ operator: '$set', path: 'summary', matched: 1 }],
    });
    expect(target.stored).toStrictEqual([{ ...BASE_DATA, summary: 'Patch semantics.' }]);
  });

  it('introduces a declared optional scalar that this revision does not carry', async () => {
    const target = host({ current: planRevision('rev-1', { title: 'T', tasks: [] }) });

    const response = await patch(request({ $set: { summary: 'Added.' } }), target);

    expect(response.ok).toBe(true);
    expect(target.stored[0]).toStrictEqual({ title: 'T', tasks: [], summary: 'Added.' });
  });

  it('reports the current revision when baseRevision is stale', async () => {
    const target = host({ current: planRevision('rev-7') });

    const response = await patch(request({ $set: { summary: 'Patch semantics.' } }), target);

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'BASE_REVISION_CONFLICT',
        message: "Artifact 'implementation-plan:plan-1' has advanced to revision 'rev-7'.",
        currentRevision: 'rev-7',
        // $set replaces a value the caller last saw on the stale revision.
        repair: expect.stringContaining('Re-read the artifact'),
      },
    });
    expect(target.stored).toStrictEqual([]);
  });

  it('rejects a misspelled path instead of creating the field', async () => {
    const target = host();

    const response = await patch(request({ $set: { summry: 'Patch semantics.' } }), target);

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'PATH_NOT_DECLARED', operator: '$set', path: 'summry' },
    });
    expect(target.stored).toStrictEqual([]);
  });

  it('rejects a value the declared schema does not accept, naming the allowed values', async () => {
    const target = host();

    const response = await patch(request({ $set: { 'tasks.0.status': 'finished' } }), target);

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'SCHEMA_VALIDATION_FAILED',
        issues: [{ path: 'tasks.0.status', allowedValues: ['open', 'in-progress', 'done'] }],
        repair: "'tasks.0.status' accepts one of: open, in-progress, done.",
      },
    });
    expect(target.stored).toStrictEqual([]);
  });

  it('names the expected type when a value has the wrong shape', async () => {
    const target = host();

    const response = await patch(request({ $set: { summary: 42 } }), target);

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'SCHEMA_VALIDATION_FAILED',
        issues: [{ path: 'summary', expectedType: 'string' }],
        repair: "'summary' expects type string.",
      },
    });
  });

  it('validates and reports without persisting on a dry run', async () => {
    const target = host();

    const response = await patch(request({ $set: { summary: 'Patch semantics.' } }, { dryRun: true }), target);

    expect(response).toStrictEqual({
      ok: true,
      dryRun: true,
      base: { refClass: 'artifact', kind: 'implementation-plan', id: 'plan-1', revision: 'rev-1' },
      operations: [{ operator: '$set', path: 'summary', matched: 1 }],
    });
    expect(target.stored).toStrictEqual([]);
  });

  it('rejects a blank title, which the serialized data schema alone still accepts', async () => {
    const target = host();

    const response = await patch(request({ $set: { title: '   ' } }), target);

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'SCHEMA_VALIDATION_FAILED',
        issues: [{ path: 'title' }],
        repair: "'title' must be a nonblank string.",
      },
    });
    expect(target.stored).toStrictEqual([]);
  });

  it('reports the blank title on a dry run too', async () => {
    const target = host();

    const response = await patch(request({ $set: { title: '   ' } }, { dryRun: true }), target);

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'SCHEMA_VALIDATION_FAILED', issues: [{ path: 'title' }] },
    });
    expect(target.stored).toStrictEqual([]);
  });
});

describe('changing a collection entry by field match', () => {
  it('changes the addressed entry and leaves its siblings untouched', async () => {
    const target = host();

    const response = await patch(request(CHANGE_ENTRY), target);

    expect(response).toMatchObject({
      ok: true,
      operations: [{ operator: '$set', path: 'tasks.$[entry].status', matched: 1 }],
    });
    expect(target.stored[0]).toStrictEqual({
      ...BASE_DATA,
      tasks: [
        { title: 'Declare the contract', status: 'done' },
        { title: 'Write the engine', status: 'done' },
        { title: 'Wire the facade', status: 'open' },
      ],
    });
  });

  it('still addresses the same entry after a concurrent insertion shifted it', async () => {
    const shifted = {
      ...structuredClone(BASE_DATA),
      tasks: [{ title: 'Inserted by another agent', status: 'open' }, ...structuredClone(BASE_DATA).tasks],
    };
    const target = host({ current: planRevision('rev-1', shifted) });

    const response = await patch(request(CHANGE_ENTRY), target);

    expect(response.ok).toBe(true);
    expect(target.stored[0]).toMatchObject({
      tasks: [
        { title: 'Inserted by another agent', status: 'open' },
        { title: 'Declare the contract', status: 'done' },
        { title: 'Write the engine', status: 'done' },
        { title: 'Wire the facade', status: 'open' },
      ],
    });
  });

  it('addresses an entry by position when the collection has no natural key', async () => {
    const target = host();

    const response = await patch(request({ $set: { 'tasks.2.status': 'in-progress' } }), target);

    expect(response).toMatchObject({ ok: true, operations: [{ matched: 1 }] });
    expect(target.stored[0]).toMatchObject({ tasks: [{}, {}, { title: 'Wire the facade', status: 'in-progress' }] });
  });

  it('rejects a position beyond the collection rather than padding it', async () => {
    const response = await patch(request({ $set: { 'tasks.9.status': 'done' } }));

    expect(response).toMatchObject({ ok: false, error: { code: 'NO_MATCH', path: 'tasks.9.status' } });
  });

  it('reports the stale base revision before inspecting the patch', async () => {
    const target = host({ current: planRevision('rev-7') });

    const response = await patch(request(CHANGE_ENTRY), target);

    expect(response).toMatchObject({ ok: false, error: { code: 'BASE_REVISION_CONFLICT', currentRevision: 'rev-7' } });
  });

  it('rejects a misspelled field below the addressed entry', async () => {
    const response = await patch(
      request({ $set: { 'tasks.$[entry].titel': 'x' }, arrayFilters: [{ 'entry.title': 'Write the engine' }] }),
    );

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'PATH_NOT_DECLARED', path: 'tasks.$[entry].titel' },
    });
  });

  it('treats an entry that matches nothing as a failure, not a no-op', async () => {
    const target = host();

    const response = await patch(
      request({ $set: { 'tasks.$[entry].status': 'done' }, arrayFilters: [{ 'entry.title': 'No such task' }] }),
      target,
    );

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'NO_MATCH', operator: '$set', path: 'tasks.$[entry].status' },
    });
    expect(target.stored).toStrictEqual([]);
  });

  it('changes every entry the filter matches and reports the count', async () => {
    const target = host();

    const response = await patch(
      request({ $set: { 'tasks.$[entry].status': 'done' }, arrayFilters: [{ 'entry.status': 'open' }] }),
      target,
    );

    expect(response).toMatchObject({ ok: true, operations: [{ matched: 2 }] });
  });

  it('reports a matched entry change on a dry run without persisting', async () => {
    const target = host();

    const response = await patch(request(CHANGE_ENTRY, { dryRun: true }), target);

    expect(response).toMatchObject({ ok: true, dryRun: true, operations: [{ matched: 1 }] });
    expect(target.stored).toStrictEqual([]);
  });

  it('rejects a change below an intermediate one matched entry does not carry', async () => {
    // Writing only the entries that can be reached would report a partial
    // change as a complete one, and the same instruction against the deficient
    // entry alone is already a rejection.
    const target = host({ current: planRevision('rev-1', structuredClone(UNEVEN_TASKS)) });

    const response = await patch(
      request({ $set: { 'tasks.$[entry].details.flag': true }, arrayFilters: OPEN_ENTRIES }),
      target,
    );

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'PATH_NOT_RESOLVABLE', operator: '$set', path: 'tasks.$[entry].details.flag' },
    });
    expect(target.stored).toStrictEqual([]);
  });

  it('rejects a removal below an intermediate one matched entry does not carry', async () => {
    const target = host({ current: planRevision('rev-1', structuredClone(UNEVEN_TASKS)) });

    const response = await patch(
      request({ $unset: { 'tasks.$[entry].details.flag': true }, arrayFilters: OPEN_ENTRIES }),
      target,
    );

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'PATH_NOT_RESOLVABLE', operator: '$unset', path: 'tasks.$[entry].details.flag' },
    });
    expect(target.stored).toStrictEqual([]);
  });

  it('rejects a position that only some of the matched entries carry', async () => {
    const target = host({ current: planRevision('rev-1', structuredClone(UNEVEN_TASKS)) });

    const response = await patch(
      request({ $set: { 'tasks.$[entry].subtasks.0': 'rewritten' }, arrayFilters: OPEN_ENTRIES }),
      target,
    );

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'NO_MATCH', operator: '$set', path: 'tasks.$[entry].subtasks.0' },
    });
    expect(target.stored).toStrictEqual([]);
  });
});

describe('appending an entry', () => {
  it('appends one entry to a declared collection', async () => {
    const target = host();

    const response = await patch(
      request({ $push: { tasks: { title: 'Publish the package', status: 'open' } } }),
      target,
    );

    expect(response).toMatchObject({ ok: true, operations: [{ operator: '$push', path: 'tasks', matched: 1 }] });
    expect(target.stored[0]).toMatchObject({
      tasks: [{}, {}, {}, { title: 'Publish the package', status: 'open' }],
    });
  });

  it('creates a declared collection this revision does not carry', async () => {
    const target = host({ current: planRevision('rev-1', { title: 'T', tasks: [] }) });

    const response = await patch(request({ $push: { blockers: 'awaiting publish' } }), target);

    expect(response.ok).toBe(true);
    expect(target.stored[0]).toStrictEqual({ title: 'T', tasks: [], blockers: ['awaiting publish'] });
  });

  it('rejects appending to a path the kind declares as a scalar', async () => {
    const response = await patch(request({ $push: { summary: 'x' } }));

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'TARGET_NOT_A_COLLECTION', operator: '$push', path: 'summary' },
    });
  });

  it('rejects appending to one entry instead of the collection', async () => {
    const response = await patch(request({ $push: { 'tasks.0': { title: 'x', status: 'open' } } }));

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'UNSUPPORTED_TARGET', operator: '$push', path: 'tasks.0' },
    });
  });

  it('rejects an appended entry the declared item schema does not accept', async () => {
    const target = host();

    const response = await patch(request({ $push: { tasks: { title: 'Publish', status: 'shipped' } } }), target);

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'SCHEMA_VALIDATION_FAILED', issues: [{ path: 'tasks.3.status' }] },
    });
    expect(target.stored).toStrictEqual([]);
  });

  it('reports the stale base revision before appending', async () => {
    const target = host({ current: planRevision('rev-7') });

    const response = await patch(request({ $push: { blockers: 'x' } }), target);

    expect(response).toMatchObject({ ok: false, error: { code: 'BASE_REVISION_CONFLICT', currentRevision: 'rev-7' } });
    expect(target.stored).toStrictEqual([]);
  });

  it('reports an append on a dry run without persisting', async () => {
    const target = host();

    const response = await patch(request({ $push: { blockers: 'x' } }, { dryRun: true }), target);

    expect(response).toMatchObject({ ok: true, dryRun: true, operations: [{ operator: '$push', matched: 1 }] });
    expect(target.stored).toStrictEqual([]);
  });
});

describe('removing an entry', () => {
  it('removes the entry the condition matches by field', async () => {
    const target = host();

    const response = await patch(request({ $pull: { tasks: { title: 'Wire the facade' } } }), target);

    expect(response).toMatchObject({ ok: true, operations: [{ operator: '$pull', path: 'tasks', matched: 1 }] });
    expect(target.stored[0]).toMatchObject({
      tasks: [
        { title: 'Declare the contract', status: 'done' },
        { title: 'Write the engine', status: 'open' },
      ],
    });
  });

  it('removes a scalar entry by value', async () => {
    const target = host();

    const response = await patch(request({ $pull: { blockers: 'awaiting review' } }), target);

    expect(response).toMatchObject({ ok: true, operations: [{ matched: 1 }] });
    expect(target.stored[0]).toMatchObject({ blockers: [] });
  });

  it('treats a condition that matches nothing as a failure, not a no-op', async () => {
    const target = host();

    const response = await patch(request({ $pull: { tasks: { title: 'No such task' } } }), target);

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'NO_MATCH', operator: '$pull', path: 'tasks' },
    });
    expect(target.stored).toStrictEqual([]);
  });

  it('rejects removing from a misspelled collection', async () => {
    const response = await patch(request({ $pull: { taks: { title: 'Wire the facade' } } }));

    expect(response).toMatchObject({ ok: false, error: { code: 'PATH_NOT_DECLARED', path: 'taks' } });
  });

  it('reports the stale base revision before removing', async () => {
    const target = host({ current: planRevision('rev-7') });

    const response = await patch(request({ $pull: { blockers: 'awaiting review' } }), target);

    expect(response).toMatchObject({ ok: false, error: { code: 'BASE_REVISION_CONFLICT', currentRevision: 'rev-7' } });
  });

  it('reports a removal on a dry run without persisting', async () => {
    const target = host();

    const response = await patch(request({ $pull: { blockers: 'awaiting review' } }, { dryRun: true }), target);

    expect(response).toMatchObject({ ok: true, dryRun: true, operations: [{ operator: '$pull', matched: 1 }] });
    expect(target.stored).toStrictEqual([]);
  });
});

describe('removing a declared property', () => {
  it('removes an optional property the revision carries', async () => {
    const target = host();

    const response = await patch(request({ $unset: { summary: true } }), target);

    expect(response).toMatchObject({ ok: true, operations: [{ operator: '$unset', path: 'summary', matched: 1 }] });
    expect(target.stored[0]).not.toHaveProperty('summary');
  });

  it('treats removing an already absent property as a failure', async () => {
    const target = host({ current: planRevision('rev-1', { title: 'T', tasks: [] }) });

    const response = await patch(request({ $unset: { summary: true } }), target);

    expect(response).toMatchObject({ ok: false, error: { code: 'NO_MATCH', operator: '$unset', path: 'summary' } });
  });

  it('rejects removing a required property, naming it', async () => {
    const target = host();

    const response = await patch(request({ $unset: { tasks: true } }), target);

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'SCHEMA_VALIDATION_FAILED', issues: [{ path: 'tasks' }] },
    });
    expect(target.stored).toStrictEqual([]);
  });

  it('directs a caller removing a collection entry to $pull', async () => {
    const response = await patch(request({ $unset: { 'tasks.0': true } }));

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'UNSUPPORTED_TARGET',
        operator: '$unset',
        path: 'tasks.0',
        repair: expect.stringContaining('$pull'),
      },
    });
  });
});

describe('combined instructions', () => {
  it('applies every instruction and reports one entry per instruction', async () => {
    const target = host();

    const response = await patch(
      request({
        $set: { 'tasks.$[entry].status': 'done' },
        $unset: { summary: true },
        $push: { blockers: 'awaiting publish' },
        $pull: { tasks: { title: 'Wire the facade' } },
        arrayFilters: [{ 'entry.title': 'Write the engine' }],
      }),
      target,
    );

    expect(response).toMatchObject({
      ok: true,
      operations: [
        { operator: '$set', path: 'tasks.$[entry].status' },
        { operator: '$unset', path: 'summary' },
        { operator: '$push', path: 'blockers' },
        { operator: '$pull', path: 'tasks' },
      ],
    });
    expect(target.stored[0]).toStrictEqual({
      title: 'Patch-based revisions',
      blockers: ['awaiting review', 'awaiting publish'],
      tasks: [
        { title: 'Declare the contract', status: 'done' },
        { title: 'Write the engine', status: 'done' },
      ],
    });
  });

  it('persists nothing when a later instruction fails', async () => {
    const target = host();

    const response = await patch(
      request({ $set: { summary: 'kept out' }, $pull: { blockers: 'no such blocker' } }),
      target,
    );

    expect(response).toMatchObject({ ok: false, error: { code: 'NO_MATCH', operator: '$pull' } });
    expect(target.stored).toStrictEqual([]);
  });
});

describe('host boundary', () => {
  it('fails closed without an authorized host', async () => {
    const result = await executePatchArtifact(parseRequest(request({ $set: { summary: 'x' } })), context);

    expect(result).toMatchObject({ success: false, error: { code: 'PERMISSION_DENIED' } });
  });

  it('returns actionable rejections in band rather than as tool failures', async () => {
    const result = await executePatchArtifact(parseRequest(request({ $set: { summry: 'x' } })), context, host());

    expect(result).toMatchObject({ success: true, data: { ok: false, error: { code: 'PATH_NOT_DECLARED' } } });
  });

  it('reports a missing artifact', async () => {
    const response = await patch(request({ $set: { summary: 'x' } }), host({ current: null }));

    expect(response).toMatchObject({ ok: false, error: { code: 'ARTIFACT_NOT_FOUND' } });
  });

  it('reports an unregistered kind', async () => {
    const response = await patch(request({ $set: { summary: 'x' } }), host({ registrations: [] }));

    expect(response).toMatchObject({ ok: false, error: { code: 'KIND_NOT_REGISTERED' } });
  });

  it('reports a revision whose schema version has no registration', async () => {
    const other = ArtifactKindRegistrationSchema.parse({ ...kind, schemaVersion: 3 });

    const response = await patch(request({ $set: { summary: 'x' } }), host({ registrations: [other] }));

    expect(response).toMatchObject({ ok: false, error: { code: 'SCHEMA_VERSION_MISMATCH' } });
  });

  it('reports a failed lookup without claiming the write happened', async () => {
    const response = await patch(request({ $set: { summary: 'x' } }), host({ failResolve: 'store offline' }));

    expect(response).toMatchObject({ ok: false, error: { code: 'HOST_FAILED' } });
  });

  it('reports a failed write as an unknown outcome instead of promising a rollback', async () => {
    // The store contract covers the compare-and-swap only. A throw can follow a
    // committed write, so the repair must not invite a blind retry.
    const response = await patch(request({ $set: { summary: 'x' } }), host({ failStore: 'write rejected' }));

    expect(response).toMatchObject({ ok: false, error: { code: 'HOST_FAILED' } });
    const repair = response.ok ? '' : response.error.repair;
    expect(repair).toContain('Re-read the artifact');
    expect(repair).not.toMatch(/nothing was persisted|Retry the same patch/);
  });

  it('hands the host the previous revision and the requested status observation', async () => {
    const target = host();

    await patch(request({ $set: { summary: 'Observed.' } }, { statusPath: '/summary' }), target);

    expect(target.writes[0]?.previous).toMatchObject({ revision: 'rev-1', data: BASE_DATA });
    expect(target.writes[0]?.statusPath).toBe('/summary');
  });

  it('omits the status observation the request did not name', async () => {
    const target = host();

    await patch(request({ $set: { summary: 'Unobserved.' } }), target);

    expect(target.writes[0]).not.toHaveProperty('statusPath');
  });

  it('refuses a store result that is not a new revision', async () => {
    const response = await patch(request({ $set: { summary: 'x' } }), host({ storedRevision: 'rev-1' }));

    expect(response).toMatchObject({ ok: false, error: { code: 'HOST_FAILED' } });
  });

  it('never mutates the payload the host handed out', async () => {
    const current = planRevision('rev-1');
    const target = host({ current });

    await patch(request({ $set: { summary: 'changed' } }), target);

    expect(current.data).toStrictEqual(BASE_DATA);
  });
});

describe('keys JSON transport cannot carry', () => {
  it('rejects a patch addressing __proto__ instead of dropping that instruction', () => {
    // Record reconstruction drops an own __proto__ key. Accepting the request
    // would apply the surviving instructions and report a complete write.
    const result = ArtifactPatchRequestSchema.safeParse(
      request({ $set: { summary: 'applied', ['__proto__']: 'vanishes' } }),
    );

    expect(result.success).toBe(false);
  });

  it('rejects __proto__ nested inside an operand', () => {
    const result = ArtifactPatchRequestSchema.safeParse(
      request({ $push: { tasks: { title: 'T', status: 'open', ['__proto__']: { polluted: true } } } }),
    );

    expect(result.success).toBe(false);
  });

  it('rejects __proto__ inside an array filter', () => {
    const result = ArtifactPatchRequestSchema.safeParse(
      request({
        $set: { 'tasks.$[entry].status': 'done' },
        arrayFilters: [{ 'entry.title': 'Write the engine', ['__proto__']: 'vanishes' }],
      }),
    );

    expect(result.success).toBe(false);
  });

  it('leaves the payload prototype untouched for a declared key that merely looks dangerous', async () => {
    const target = host();

    await patch(request({ $set: { summary: 'plain' } }), target);

    expect(Object.getPrototypeOf(target.stored[0])).toBe(Object.prototype);
  });
});

describe('concurrent writes', () => {
  it('reports a refusal by the store as a base revision conflict', async () => {
    const target = host({ storeConflictsWith: 'rev-9' });

    const response = await patch(request({ $pull: { blockers: 'awaiting review' } }), target);

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'BASE_REVISION_CONFLICT', currentRevision: 'rev-9' },
    });
    expect(target.stored).toStrictEqual([]);
  });

  it('tells a caller who only appends to resend the patch', async () => {
    const target = host({ storeConflictsWith: 'rev-9' });

    const response = await patch(request({ $push: { blockers: 'awaiting publish' } }), target);

    expect(response).toMatchObject({
      ok: false,
      error: { repair: expect.stringContaining('Resend the same patch') },
    });
  });

  it('tells a caller appending through a filter to re-read before rewriting the patch', async () => {
    // The filter compares a field the concurrent revision may have edited, and
    // another matching entry may have appeared since, so resending the append
    // would add the entry to a different set of collections than the caller
    // addressed. Only a fixed path makes an append repeatable.
    const response = await patch(
      request({
        $push: { 'tasks.$[entry].subtasks': 'Draft the release note' },
        arrayFilters: [{ 'entry.title': 'Write the engine' }],
      }),
      host({ current: planRevision('rev-7') }),
    );

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'BASE_REVISION_CONFLICT', repair: expect.stringContaining('Re-read the artifact') },
    });
  });

  it('tells a caller removing a property to re-read before rewriting the patch', async () => {
    // $unset deletes state the caller has not re-read; the concurrent revision
    // may have written the very value the resend would drop.
    const response = await patch(request({ $unset: { summary: true } }), host({ storeConflictsWith: 'rev-9' }));

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'BASE_REVISION_CONFLICT', repair: expect.stringContaining('Re-read the artifact') },
    });
  });

  it('tells a caller removing a collection entry to re-read before rewriting the patch', async () => {
    // Match-based addressing keeps the target stable, but the removal itself is
    // not repeatable: the entry may have been revised since the caller read it.
    // One such instruction disqualifies the whole patch, appends included.
    const byCondition = await patch(
      request({ $pull: { tasks: { title: 'Wire the facade' } } }),
      host({ storeConflictsWith: 'rev-9' }),
    );
    const besideAnAppend = await patch(
      request({ $pull: { blockers: 'awaiting review' }, $push: { blockers: 'awaiting publish' } }),
      host({ current: planRevision('rev-7') }),
    );

    for (const response of [byCondition, besideAnAppend]) {
      expect(response).toMatchObject({
        ok: false,
        error: { code: 'BASE_REVISION_CONFLICT', repair: expect.stringContaining('Re-read the artifact') },
      });
    }
  });

  it('tells a caller addressing by position to re-read before rewriting the patch', async () => {
    const target = host({ current: planRevision('rev-7') });

    const response = await patch(request({ $unset: { 'tasks.0.notes': true } }), target);

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'BASE_REVISION_CONFLICT', repair: expect.stringContaining('Re-read the artifact') },
    });
  });
});

describe('intersected kind schemas', () => {
  const intersected = ArtifactKindRegistrationSchema.parse({
    kind: 'intersected-plan',
    description: 'A plan whose collection is declared through an intersection.',
    schemaVersion: 1,
    category: 'commitment',
    titlePath: 'title',
    dataSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        tasks: {
          allOf: [{ type: 'array', items: { type: 'object', properties: { title: { type: 'string' } } } }],
        },
      },
      required: ['title'],
    },
  });

  it('addresses an entry of a collection declared through allOf', async () => {
    const current = ArtifactRevisionSchema.parse({
      kind: 'intersected-plan',
      id: 'plan-2',
      revision: 'rev-1',
      schemaVersion: 1,
      scope: { level: 'global' },
      data: { title: 'Intersected', tasks: [{ title: 'first' }] },
      relations: [],
      actor: { kind: 'agent', id: 'test' },
      timestamp: 0,
    });
    const target: ArtifactPatchHost = {
      listKinds: async () => [intersected],
      resolveCurrent: async () => current,
      store: async (write) => ({ ...current, revision: 'rev-2', data: write.data }),
    };

    const response = await patchArtifact(
      ArtifactPatchRequestSchema.parse({
        ref: { kind: 'intersected-plan', id: 'plan-2' },
        baseRevision: 'rev-1',
        patch: { $set: { 'tasks.0.title': 'renamed' } },
      }),
      context,
      target,
    );

    expect(response).toMatchObject({ ok: true, operations: [{ matched: 1 }] });
  });
});

describe('extension contribution', () => {
  it('contributes no tools until a host is bound', () => {
    // The unbound contribution must remain empty even before activation provides a context.
    expect(Reflect.apply(artifactPatchPackage.tools!.createToolsets!, undefined, [])).toStrictEqual([]);
    expect(Reflect.apply(createArtifactPatchPackage().tools!.createToolsets!, undefined, [])).toStrictEqual([]);
  });

  it('contributes the patch tool once a host is bound', () => {
    const toolsets: Toolset[] = Reflect.apply(createArtifactPatchPackage(host()).tools!.createToolsets!, undefined, []);

    expect(toolsets.flatMap((toolset) => Object.keys(toolset.tools))).toStrictEqual(['artifacts_patch']);
  });
});
