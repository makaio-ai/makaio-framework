import { describe, expect, it } from 'vitest';
import { ArtifactKindRegistrationSchema, compileArtifactDataChecker, compileArtifactDataSchema } from '../../index.js';

const registration = ArtifactKindRegistrationSchema.parse({
  kind: 'timestamped-note',
  description: 'A note with an ISO date-time observation.',
  schemaVersion: 1,
  category: 'knowledge',
  titlePath: 'title',
  dataSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      title: { type: 'string' },
      observedAt: { type: 'string', format: 'date-time' },
    },
    required: ['title', 'observedAt'],
  },
});

describe('compileArtifactDataSchema', () => {
  it('uses supported JSON Schema date-time formats for complete payload validation', () => {
    const validate = compileArtifactDataSchema(registration);

    expect(validate({ title: 'Release review', observedAt: '2026-09-09T20:00:00+02:00' })).toBe(true);
    expect(validate({ title: 'Release review', observedAt: '2026-99-99T20:00:00+02:00' })).toBe(false);
  });
});

const catalogued = ArtifactKindRegistrationSchema.parse({
  kind: 'catalogued-note',
  description: 'A note with a classified state and a closed shape.',
  schemaVersion: 1,
  category: 'knowledge',
  titlePath: 'title',
  dataSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: { type: 'string' },
      state: { type: 'string', enum: ['valid', 'retired'] },
      tags: { type: 'array', items: { type: 'string' } },
    },
    required: ['title', 'state'],
  },
});

describe('compileArtifactDataChecker', () => {
  it('reports a valid payload without issues', () => {
    const check = compileArtifactDataChecker(catalogued);

    expect(check({ title: 'Release review', state: 'valid' })).toStrictEqual({ valid: true });
  });

  it('names the declared value set of a rejected classification', () => {
    const check = compileArtifactDataChecker(catalogued);

    expect(check({ title: 'Release review', state: 'archived' })).toStrictEqual({
      valid: false,
      issues: [
        {
          path: 'state',
          reason: 'must be equal to one of the allowed values',
          allowedValues: ['valid', 'retired'],
        },
      ],
    });
  });

  it('names the declared type and the position of a rejected element', () => {
    const check = compileArtifactDataChecker(catalogued);

    expect(check({ title: 'Release review', state: 'valid', tags: ['ok', 7] })).toStrictEqual({
      valid: false,
      issues: [{ path: 'tags.1', reason: 'must be string', expectedType: 'string' }],
    });
  });

  it('addresses a missing required property by its own name', () => {
    const check = compileArtifactDataChecker(catalogued);
    const result = check({ title: 'Release review' });

    expect(result.valid).toBe(false);
    expect(result.valid ? [] : result.issues).toContainEqual(
      expect.objectContaining({ path: 'state', reason: "must have required property 'state'" }),
    );
  });

  it('addresses a surplus property by its own name', () => {
    const check = compileArtifactDataChecker(catalogued);
    const result = check({ title: 'Release review', state: 'valid', summry: 'typo' });

    expect(result.valid).toBe(false);
    expect(result.valid ? [] : result.issues).toContainEqual(expect.objectContaining({ path: 'summry' }));
  });

  it('reports each call independently', () => {
    const check = compileArtifactDataChecker(catalogued);

    expect(check({ title: 'Release review', state: 'archived' }).valid).toBe(false);
    expect(check({ title: 'Release review', state: 'valid' })).toStrictEqual({ valid: true });
  });
});
