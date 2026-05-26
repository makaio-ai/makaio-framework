import { describe, expect, it } from 'vitest';
import { ArtifactSchema } from '../schemas.js';

const baseArtifact = {
  id: 'artifact-1',
  type: 'plan',
  mimeType: 'text/markdown',
  metadata: {},
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
};

describe('ArtifactSchema', () => {
  it('rejects session-scoped artifacts without sessionId', () => {
    const result = ArtifactSchema.safeParse({
      ...baseArtifact,
      scope: 'session',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(['sessionId']);
    }
  });

  it('accepts session-scoped artifacts with sessionId', () => {
    const result = ArtifactSchema.safeParse({
      ...baseArtifact,
      scope: 'session',
      sessionId: 'session-1',
    });

    expect(result.success).toBe(true);
  });

  it('accepts global artifacts without sessionId', () => {
    const result = ArtifactSchema.safeParse({
      ...baseArtifact,
      scope: 'global',
    });

    expect(result.success).toBe(true);
  });
});
