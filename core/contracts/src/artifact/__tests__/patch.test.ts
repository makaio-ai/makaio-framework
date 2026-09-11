import { describe, expect, it } from 'vitest';
import {
  ArtifactPatchDocumentSchema,
  ArtifactPatchErrorSchema,
  ArtifactPatchRequestSchema,
  ArtifactPatchResponseSchema,
} from '../patch.js';

describe('patch rejection contract', () => {
  it('accepts a base revision conflict that names the current revision', () => {
    const result = ArtifactPatchErrorSchema.safeParse({
      code: 'BASE_REVISION_CONFLICT',
      message: "Artifact 'plan:plan-1' has advanced to revision 'rev-7'.",
      currentRevision: 'rev-7',
      repair: "Re-read the artifact at revision 'rev-7' and rewrite the patch.",
    });

    expect(result.success).toBe(true);
  });

  it('rejects a base revision conflict that does not name the current revision', () => {
    // Recovery from a conflict is rebasing onto the revision the artifact
    // carries, so a conflict without it leaves the caller nothing to act on.
    const result = ArtifactPatchErrorSchema.safeParse({
      code: 'BASE_REVISION_CONFLICT',
      message: "Artifact 'plan:plan-1' has advanced.",
      repair: 'Re-read the artifact and rewrite the patch.',
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toStrictEqual(['currentRevision']);
  });

  it('accepts any other rejection without a current revision', () => {
    const result = ArtifactPatchErrorSchema.safeParse({
      code: 'PATH_NOT_DECLARED',
      message: "The artifact kind does not declare 'summry'.",
      operator: '$set',
      path: 'summry',
      repair: 'Correct the path to one the kind schema declares.',
    });

    expect(result.success).toBe(true);
  });

  it('accepts a store rejection with per-path issues', () => {
    // STORE_REJECTED is the host's deterministic refusal: nothing persisted,
    // so unlike HOST_FAILED the repair can promise a corrected resend.
    const result = ArtifactPatchErrorSchema.safeParse({
      code: 'STORE_REJECTED',
      message: "The host refused the write: 'origin.url' is immutable.",
      issues: [{ path: 'origin.url', reason: 'immutable path changed' }],
      repair: "Drop the change to 'origin.url' and resend the patch.",
    });

    expect(result.success).toBe(true);
  });

  it('carries the rejection through the response envelope unchanged', () => {
    const result = ArtifactPatchResponseSchema.safeParse({
      ok: false,
      error: {
        code: 'BASE_REVISION_CONFLICT',
        message: "Artifact 'plan:plan-1' has advanced to revision 'rev-7'.",
        currentRevision: 'rev-7',
        repair: "Resend the same patch with baseRevision 'rev-7'.",
      },
    });

    expect(result.success).toBe(true);
  });
});

describe('patch request target schema version', () => {
  const base = {
    ref: { kind: 'plan', id: 'plan-1' },
    baseRevision: 'rev-1',
    patch: { $set: { summary: 'x' } },
  };

  it('accepts a positive integer target', () => {
    const result = ArtifactPatchRequestSchema.safeParse({ ...base, schemaVersion: 3 });

    expect(result.success).toBe(true);
    expect(result.data?.schemaVersion).toBe(3);
  });

  it('leaves the target undefined when the request omits it', () => {
    const result = ArtifactPatchRequestSchema.safeParse(base);

    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty('schemaVersion');
  });

  it.each([0, -1, 1.5, '2'])('rejects %j as a target', (schemaVersion) => {
    const result = ArtifactPatchRequestSchema.safeParse({ ...base, schemaVersion });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toStrictEqual(['schemaVersion']);
  });

  it('accepts an instructionless patch when a target version is named', () => {
    const result = ArtifactPatchRequestSchema.safeParse({ ...base, patch: {}, schemaVersion: 3 });

    expect(result.success).toBe(true);
  });

  it('rejects an instructionless patch without a target version', () => {
    const result = ArtifactPatchRequestSchema.safeParse({ ...base, patch: {} });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toStrictEqual(['patch']);
  });

  it('keeps requiring an instruction on the standalone document', () => {
    const result = ArtifactPatchDocumentSchema.safeParse({});

    expect(result.success).toBe(false);
  });
});

describe('patch success operations', () => {
  const ref = { refClass: 'artifact', kind: 'decision', id: 'dec-1', revision: 'rev-1' };
  const next = { ...ref, revision: 'rev-2' };

  it('rejects an ordinary success that reports no applied instruction', () => {
    const result = ArtifactPatchResponseSchema.safeParse({
      ok: true,
      base: ref,
      dryRun: false,
      artifact: next,
      operations: [],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toStrictEqual(['operations']);
  });

  it('rejects an instructionless dry run that is not a migration', () => {
    const result = ArtifactPatchResponseSchema.safeParse({ ok: true, base: ref, dryRun: true, operations: [] });

    expect(result.success).toBe(false);
  });

  it('rejects a migration marker whose endpoints are equal', () => {
    const result = ArtifactPatchResponseSchema.safeParse({
      ok: true,
      base: ref,
      dryRun: false,
      artifact: next,
      operations: [],
      migration: { from: 2, to: 2 },
    });

    expect(result.success).toBe(false);
  });

  it('rejects a migration marker that moves backwards', () => {
    const result = ArtifactPatchResponseSchema.safeParse({
      ok: true,
      base: ref,
      dryRun: false,
      artifact: next,
      operations: [],
      migration: { from: 3, to: 2 },
    });

    expect(result.success).toBe(false);
  });

  it('accepts an instructionless success that names its migration', () => {
    const result = ArtifactPatchResponseSchema.safeParse({
      ok: true,
      base: ref,
      dryRun: false,
      artifact: next,
      operations: [],
      migration: { from: 1, to: 2 },
    });

    expect(result.success).toBe(true);
  });
});

describe('patch request rendering hints', () => {
  const base = {
    ref: { kind: 'plan', id: 'plan-1' },
    baseRevision: 'rev-1',
    patch: { $set: { summary: 'x' } },
  };

  it('accepts replacement hints', () => {
    const result = ArtifactPatchRequestSchema.safeParse({
      ...base,
      representations: { summary: 'Fresh summary.', markdown: '# Fresh' },
    });

    expect(result.success).toBe(true);
  });

  it('accepts null to clear the hints', () => {
    const result = ArtifactPatchRequestSchema.safeParse({ ...base, representations: null });

    expect(result.success).toBe(true);
    expect(result.data?.representations).toBeNull();
  });

  it('leaves the hints undefined when the request omits them', () => {
    const result = ArtifactPatchRequestSchema.safeParse(base);

    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty('representations');
  });

  it('rejects a misspelled hint key instead of stripping it into a wholesale clear', () => {
    const result = ArtifactPatchRequestSchema.safeParse({ ...base, representations: { plainText: 'x' } });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toStrictEqual(['representations']);
  });

  it('rejects hints outside the shared representations shape', () => {
    const result = ArtifactPatchRequestSchema.safeParse({ ...base, representations: { summary: 42 } });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toStrictEqual(['representations', 'summary']);
  });
});
