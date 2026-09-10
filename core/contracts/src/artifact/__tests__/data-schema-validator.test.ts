import { describe, expect, it } from 'vitest';
import { ArtifactKindRegistrationSchema, compileArtifactDataSchema } from '../../index.js';

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
