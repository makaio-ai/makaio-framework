import { describe, expect, it } from 'vitest';
import { ArtifactKindRegistrationSchema, ArtifactPatchRequestSchema, ArtifactRevisionSchema } from '@makaio/contracts';
import type { Toolset } from '@makaio/tools-core';
import { executePatchArtifact } from '../patch-artifact.js';
import { artifactPatchPackage, createArtifactPatchPackage } from '../index.js';
import {
  kind,
  BASE_DATA,
  planRevision,
  host,
  context,
  parseRequest,
  patch,
  request,
  type ArtifactPatchHost,
} from './patch-artifact.test-support.js';

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
        code: 'PAYLOAD_INVARIANT_FAILED',
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
      error: { code: 'PAYLOAD_INVARIANT_FAILED', issues: [{ path: 'title' }] },
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

  it('reports a deterministic store refusal as rejected with nothing persisted', async () => {
    const recording = host({
      rejectStore: {
        message: "'origin.url' is immutable for kind 'external-document'.",
        issues: [{ path: 'origin.url', reason: 'immutable path changed' }],
      },
    });

    const response = await patch(request({ $set: { summary: 'x' } }), recording);

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'STORE_REJECTED',
        issues: [{ path: 'origin.url', reason: 'immutable path changed' }],
      },
    });
    const error = response.ok ? undefined : response.error;
    expect(error?.message).toContain("'origin.url' is immutable");
    expect(error?.repair).toContain('Nothing was persisted');
    expect(recording.persisted).toHaveLength(0);
  });

  it('drops malformed host issues instead of violating the response contract', async () => {
    // The response schema is strict and requires a non-empty reason; the tool
    // registry does not re-validate successful output, so the boundary must.
    const recording = host({
      rejectStore: {
        message: 'refused',
        issues: [
          { path: 'origin.url', reason: '' },
          { path: 'origin.url', reason: 'immutable path changed' },
        ],
      },
    });

    const response = await patch(request({ $set: { summary: 'x' } }), recording);

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'STORE_REJECTED', issues: [{ path: 'origin.url', reason: 'immutable path changed' }] },
    });
  });

  it('replaces a blank refusal message instead of manufacturing an empty reason', async () => {
    const response = await patch(request({ $set: { summary: 'x' } }), host({ rejectStore: { message: '  ' } }));

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'STORE_REJECTED', message: 'The host refused the write without naming a reason.' },
    });
  });

  it('omits issues from a store refusal that names none', async () => {
    const response = await patch(request({ $set: { summary: 'x' } }), host({ rejectStore: { message: 'refused' } }));

    expect(response).toMatchObject({ ok: false, error: { code: 'STORE_REJECTED' } });
    expect(response.ok ? undefined : response.error.issues).toBeUndefined();
  });

  it('hands the host the previous revision and the requested status observation', async () => {
    const target = host();

    await patch(request({ $set: { summary: 'Observed.' } }, { statusPath: '/summary' }), target);

    expect(target.writes[0]?.previous).toMatchObject({ revision: 'rev-1', data: BASE_DATA });
    expect(target.writes[0]?.statusPath).toBe('/summary');
    expect(target.writes[0]?.schemaVersion).toBe(2);
  });

  it('omits the status observation the request did not name', async () => {
    const target = host();

    await patch(request({ $set: { summary: 'Unobserved.' } }), target);

    expect(target.writes[0]).not.toHaveProperty('statusPath');
  });

  it('hands the host replacement rendering hints when the request names them', async () => {
    const target = host();

    await patch(
      request({ $set: { summary: 'Rewritten.' } }, { representations: { summary: 'Rewritten summary.' } }),
      target,
    );

    expect(target.writes[0]?.representations).toStrictEqual({ summary: 'Rewritten summary.' });
  });

  it('hands the host an explicit null to clear rendering hints', async () => {
    const target = host();

    await patch(request({ $set: { summary: 'Cleared.' } }, { representations: null }), target);

    expect(target.writes[0]).toHaveProperty('representations', null);
  });

  it('omits rendering hints the request did not name so the host keeps the previous ones', async () => {
    const target = host();

    await patch(request({ $set: { summary: 'Untouched hints.' } }), target);

    expect(target.writes[0]).not.toHaveProperty('representations');
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

  it('tells a caller who appends but also replaces rendering hints to re-read first', async () => {
    // The hints were written against the base the caller read; resending them
    // would overwrite whatever the concurrent revision put there.
    const target = host({ storeConflictsWith: 'rev-9' });

    const response = await patch(
      request({ $push: { blockers: 'awaiting publish' } }, { representations: { summary: 'Blocked.' } }),
      target,
    );

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'BASE_REVISION_CONFLICT', repair: expect.stringContaining('Re-read the artifact') },
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

    const response = await patch(
      {
        ref: { kind: 'intersected-plan', id: 'plan-2' },
        baseRevision: 'rev-1',
        patch: { $set: { 'tasks.0.title': 'renamed' } },
      },
      target,
    );

    expect(response).toMatchObject({ ok: true, operations: [{ matched: 1 }] });
  });
});

describe('migrating between schema versions', () => {
  /** The kind after a bump: version 3 requires an owner the version 2 payload lacks. */
  const bumped = ArtifactKindRegistrationSchema.parse({
    ...kind,
    schemaVersion: 3,
    dataSchema: {
      ...kind.dataSchema,
      properties: { ...(kind.dataSchema.properties as Record<string, unknown>), owner: { type: 'string' } },
      required: ['title', 'tasks', 'owner'],
    },
  });

  it('migrates a revision to the target version when the patch makes the payload fit', async () => {
    const target = host({ registrations: [bumped] });

    const response = await patch(request({ $set: { owner: 'alice' } }, { schemaVersion: 3 }), target);

    expect(response).toMatchObject({ ok: true, dryRun: false, migration: { from: 2, to: 3 } });
    expect(target.writes[0]?.previous.schemaVersion).toBe(2);
    expect(target.writes[0]?.schemaVersion).toBe(3);
    expect(target.persisted[0]?.schemaVersion).toBe(3);
    expect(target.stored[0]).toMatchObject({ ...BASE_DATA, owner: 'alice' });
  });

  it('refuses a host that stored the migrated revision under the old version', async () => {
    const response = await patch(
      request({ $set: { owner: 'alice' } }, { schemaVersion: 3 }),
      host({ registrations: [bumped], storedSchemaVersion: 2 }),
    );

    expect(response).toMatchObject({ ok: false, error: { code: 'HOST_FAILED' } });
    const message = response.ok ? '' : response.error.message;
    expect(message).toContain('schema version 2 instead of 3');
  });

  it('lets a migration remove what the target schema no longer declares', async () => {
    // Version 3 drops `summary` and renames nothing else; the payload can only
    // satisfy `additionalProperties: false` once the old property is gone.
    const dropped = ArtifactKindRegistrationSchema.parse({
      ...kind,
      schemaVersion: 3,
      dataSchema: {
        ...kind.dataSchema,
        properties: Object.fromEntries(
          Object.entries(kind.dataSchema.properties as Record<string, unknown>).filter(([name]) => name !== 'summary'),
        ),
      },
    });
    const target = host({ registrations: [dropped] });

    const response = await patch(request({ $unset: { summary: true } }, { schemaVersion: 3 }), target);

    expect(response).toMatchObject({ ok: true, operations: [{ operator: '$unset', path: 'summary', matched: 1 }] });
    expect(target.stored[0]).not.toHaveProperty('summary');
    expect(target.persisted[0]?.schemaVersion).toBe(3);
  });

  it('refuses to migrate an artifact back to an older schema version', async () => {
    const response = await patch(
      request({ $set: { summary: 'older' } }, { schemaVersion: 1 }),
      host({ registrations: [ArtifactKindRegistrationSchema.parse({ ...kind, schemaVersion: 1 }), kind] }),
    );

    expect(response).toMatchObject({ ok: false, error: { code: 'SCHEMA_VERSION_MISMATCH' } });
    const message = response.ok ? '' : response.error.message;
    expect(message).toContain('never moves an artifact back');
  });

  it('still rejects an undeclared removal that the revision does not carry', async () => {
    const response = await patch(
      request({ $unset: { legacy: true } }, { schemaVersion: 3 }),
      host({ registrations: [bumped] }),
    );

    expect(response).toMatchObject({ ok: false, error: { code: 'NO_MATCH', path: 'legacy' } });
  });

  it('keeps refusing undeclared removals when the request is not a migration', async () => {
    const response = await patch(request({ $unset: { legacy: true } }), host());

    expect(response).toMatchObject({ ok: false, error: { code: 'PATH_NOT_DECLARED', path: 'legacy' } });
  });

  it('migrates without an instruction when the payload already fits the target', async () => {
    // Version 3 changed nothing the payload has to satisfy.
    const relabelled = ArtifactKindRegistrationSchema.parse({ ...kind, schemaVersion: 3 });
    const target = host({ registrations: [relabelled] });

    const response = await patch(request({}, { schemaVersion: 3 }), target);

    expect(response).toStrictEqual({
      ok: true,
      base: { refClass: 'artifact', kind: 'implementation-plan', id: 'plan-1', revision: 'rev-1' },
      dryRun: false,
      artifact: { refClass: 'artifact', kind: 'implementation-plan', id: 'plan-1', revision: 'rev-2' },
      operations: [],
      migration: { from: 2, to: 3 },
    });
    expect(target.stored[0]).toStrictEqual(BASE_DATA);
    expect(target.persisted[0]?.schemaVersion).toBe(3);
  });

  it('refuses an instructionless patch that targets the version the base already has', async () => {
    const response = await patch(request({}, { schemaVersion: 2 }), host());

    expect(response).toMatchObject({ ok: false, error: { code: 'NO_CHANGE' } });
  });

  it('holds the patched result to the target registration', async () => {
    // Version 3 requires the owner; a patch that names the version without
    // supplying it fails the target schema, not the base one.
    const response = await patch(
      request({ $set: { summary: 'x' } }, { schemaVersion: 3 }),
      host({ registrations: [bumped] }),
    );

    expect(response).toMatchObject({ ok: false, error: { code: 'SCHEMA_VALIDATION_FAILED' } });
  });

  it('checks declared paths against the target registration, not the base one', async () => {
    // `owner` exists only at version 3: without a target the path is undeclared
    // even though the same instruction migrates cleanly with one.
    const both = [kind, bumped];

    const undeclared = await patch(request({ $set: { owner: 'alice' } }), host({ registrations: both }));
    const migrated = await patch(
      request({ $set: { owner: 'alice' } }, { schemaVersion: 3 }),
      host({ registrations: both }),
    );

    expect(undeclared).toMatchObject({ ok: false, error: { code: 'PATH_NOT_DECLARED', path: 'owner' } });
    expect(migrated).toMatchObject({ ok: true });
  });

  it('names the registered versions when the base revision has no registration', async () => {
    const response = await patch(request({ $set: { summary: 'x' } }), host({ registrations: [bumped] }));

    expect(response).toMatchObject({ ok: false, error: { code: 'SCHEMA_VERSION_MISMATCH' } });
    const error = response.ok ? undefined : response.error;
    expect(error?.message).toContain('schema version 2');
    expect(error?.message).toContain('registered: 3');
    expect(error?.repair).toContain('schemaVersion');
  });

  it('recommends only versions newer than the revision in the repair hint', async () => {
    // The artifact is at version 3 and only version 2 is registered: naming 2
    // would be rejected as a downgrade, so the hint must not suggest it.
    const response = await patch(
      request({ $set: { summary: 'x' } }),
      host({ current: planRevision('rev-1', structuredClone(BASE_DATA), 3), registrations: [kind] }),
    );

    expect(response).toMatchObject({ ok: false, error: { code: 'SCHEMA_VERSION_MISMATCH' } });
    const error = response.ok ? undefined : response.error;
    expect(error?.message).toContain('registered: 2');
    expect(error?.repair).not.toContain('Set schemaVersion');
    expect(error?.repair).toContain('schema version 3 or newer');
  });

  it('names the target and the registered versions when the target has no registration', async () => {
    const response = await patch(
      request({ $set: { summary: 'x' } }, { schemaVersion: 4 }),
      host({ registrations: [kind, bumped] }),
    );

    expect(response).toMatchObject({ ok: false, error: { code: 'SCHEMA_VERSION_MISMATCH' } });
    const error = response.ok ? undefined : response.error;
    expect(error?.message).toContain('targets schema version 4');
    expect(error?.message).toContain('registered: 2, 3');
  });

  it('never resends a patch that names a target version after a conflict', async () => {
    // Even an append that would otherwise be rebasable: the version was chosen
    // against the base the caller read, and the concurrent revision may itself
    // have migrated the artifact.
    const response = await patch(
      request({ $push: { blockers: 'x' } }, { schemaVersion: 2 }),
      host({ storeConflictsWith: 'rev-9' }),
    );

    expect(response).toMatchObject({ ok: false, error: { code: 'BASE_REVISION_CONFLICT', currentRevision: 'rev-9' } });
    const repair = response.ok ? '' : response.error.repair;
    expect(repair).toContain('Re-read the artifact');
  });

  it('keeps the base version when the request names none', async () => {
    const target = host({ registrations: [kind, bumped] });

    await patch(request({ $set: { summary: 'x' } }), target);

    expect(target.writes[0]?.schemaVersion).toBe(2);
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
