import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ArtifactKindRegistrationSchema } from '../kind-registration.js';
import { defineArtifactKind } from '../kind-definition.js';
import { ArtifactSchemas } from '../namespace.js';
import { ArtifactQueryRequestSchema, ArtifactRevisionSchema } from '../schemas.js';
import { ARTIFACT_SLUG_PATTERN, ArtifactSlugSchema, slugify } from '../slug.js';

const actor = { kind: 'agent', id: 'planner' } as const;

const revision = {
  kind: 'implementation-plan',
  id: 'plan-1',
  slug: 'payment-plan',
  revision: 'r1',
  scope: { level: 'global' as const },
  schemaVersion: 1,
  data: { topic: 'Payment' },
  relations: [],
  actor,
  timestamp: 0,
};

describe('ArtifactSlugSchema', () => {
  it.each(['a', 'my-slug', 'my--slug', 'konzeptbaum--prozess-orchestrierung', 'v2-0'])('accepts %s', (slug) => {
    expect(ArtifactSlugSchema.parse(slug)).toBe(slug);
    expect(ARTIFACT_SLUG_PATTERN.test(slug)).toBe(true);
  });

  it.each([
    '',
    '-leading',
    'trailing-',
    'Upper',
    'under_score',
    'sp ace',
    'triple---hyphen',
    'ümlaut',
  ])('rejects %j', (slug) => {
    expect(ArtifactSlugSchema.safeParse(slug).success).toBe(false);
  });
});

describe('slugify', () => {
  it('derives a valid slug from a title with diacritics, punctuation, and casing', () => {
    expect(slugify('Stationen & Workflows: Übersicht (v2)')).toBe('stationen-workflows-ubersicht-v2');
  });

  it('collapses separator runs and trims the ends', () => {
    expect(slugify('  --Hello___World--  ')).toBe('hello-world');
  });

  it('returns null when nothing usable remains', () => {
    expect(slugify('!!! ???')).toBeNull();
    expect(slugify('')).toBeNull();
  });

  it('always produces a value that satisfies the slug pattern', () => {
    for (const text of ['Ranking Voucher Service', 'A/B Test #3', 'ÄÖÜ ß', 'x']) {
      const slug = slugify(text);
      expect(slug).not.toBeNull();
      expect(ArtifactSlugSchema.safeParse(slug).success).toBe(true);
    }
  });
});

describe('envelope slug', () => {
  it('is a required envelope field of a revision', () => {
    expect(ArtifactRevisionSchema.parse(revision).slug).toBe('payment-plan');
    const { slug: _omitted, ...withoutSlug } = revision;
    expect(ArtifactRevisionSchema.safeParse(withoutSlug).success).toBe(false);
  });

  it('is optional on create and absent from a revise body', () => {
    const { id: _id, slug: _slug, revision: _revision, timestamp: _timestamp, ...body } = revision;
    expect(ArtifactSchemas.create.request.parse(body)).not.toHaveProperty('slug');
    expect(ArtifactSchemas.create.request.parse({ ...body, slug: 'custom-address' }).slug).toBe('custom-address');
    expect(ArtifactSchemas.create.request.safeParse({ ...body, slug: 'Not Valid' }).success).toBe(false);
    expect(ArtifactSchemas.revise.request.shape.revision.safeParse({ ...body, slug: 'renamed' }).success).toBe(true);
    expect(ArtifactSchemas.revise.request.shape.revision.parse({ ...body, slug: 'renamed' })).not.toHaveProperty(
      'slug',
    );
  });

  it('is a query filter', () => {
    expect(ArtifactQueryRequestSchema.parse({ kind: 'system', slug: 'ai-factory' }).slug).toBe('ai-factory');
    expect(ArtifactQueryRequestSchema.safeParse({ slug: 'Not Valid' }).success).toBe(false);
  });
});

describe('kind registration', () => {
  it('rejects a data field named slug because the envelope owns it', () => {
    const result = ArtifactKindRegistrationSchema.safeParse({
      kind: 'system',
      description: 'A system.',
      schemaVersion: 1,
      category: 'knowledge',
      titlePath: 'name',
      dataSchema: {
        type: 'object',
        properties: { name: { type: 'string' }, slug: { type: 'string' } },
        required: ['name', 'slug'],
      },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain('dataSchema.properties.slug');
  });

  it('rejects a live kind definition that declares a slug data field', () => {
    expect(() =>
      defineArtifactKind({
        kind: 'system',
        description: 'A system.',
        schemaVersion: 1,
        category: 'knowledge',
        titlePath: 'name',
        dataSchema: z.strictObject({ name: z.string(), slug: z.string() }),
      }),
    ).toThrow(/reserved/);
  });

  it('accepts a kind without a slug data field', () => {
    const definition = defineArtifactKind({
      kind: 'system',
      description: 'A system.',
      schemaVersion: 1,
      category: 'knowledge',
      titlePath: 'name',
      dataSchema: z.strictObject({ name: z.string() }),
    });
    expect(ArtifactKindRegistrationSchema.safeParse(definition.toRegistration()).success).toBe(true);
  });
});
