import { describe, expect, it } from 'vitest';
import { ArtifactPatchErrorSchema, ArtifactPatchRequestSchema, ArtifactPatchResponseSchema } from '../patch.js';

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
