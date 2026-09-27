import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ArtifactKindRegistrationSchema } from '../kind-registration.js';
import { defineArtifactKind } from '../kind-definition.js';
import { ArtifactSchemas } from '../namespace.js';
import { ArtifactQueryRequestSchema, ArtifactRevisionSchema } from '../schemas.js';
import {
  ARTIFACT_DERIVED_SLUG_MAX_LENGTH,
  ARTIFACT_SLUG_PATTERN,
  ArtifactSlugSchema,
  deriveArtifactSlug,
  slugify,
} from '../slug.js';
import { mayArtifactDataCarryProperty } from '../kind-reserved-fields.js';
import { compileArtifactDataChecker, compileArtifactDataSchema } from '../data-schema-validator.js';

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
    expect(slugify('Stationen & Workflows: Übersicht (v2)')).toBe('stationen-workflows-uebersicht-v2');
  });

  it('collapses separator runs and trims the ends', () => {
    expect(slugify('  --Hello___World--  ')).toBe('hello-world');
  });

  it('transliterates German umlauts and sharp s instead of dropping them', () => {
    expect(slugify('Maßnahmen für Größe')).toBe('massnahmen-fuer-groesse');
    expect(slugify('Ähnliche Übersicht')).toBe('aehnliche-uebersicht');
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

describe('deriveArtifactSlug', () => {
  it('derives from the title selected by titlePath', () => {
    expect(deriveArtifactSlug({ meta: { title: 'AI Factory' } }, 'meta.title', 'ignored')).toBe('ai-factory');
  });

  it('falls back to the artifact identity when the title yields nothing', () => {
    expect(deriveArtifactSlug({ title: '???' }, 'title', '5d2c0a1e-1f2b-4c3d-9e8f-0a1b2c3d4e5f')).toBe(
      '5d2c0a1e-1f2b-4c3d-9e8f-0a1b2c3d4e5f',
    );
  });

  it('throws when neither title nor identity yields a slug', () => {
    expect(() => deriveArtifactSlug({ title: '???' }, 'title', '!!!')).toThrow(/yields no slug/);
  });
});

describe('deriveArtifactSlug length cap', () => {
  const derive = (title: string, id = 'ignored'): string => deriveArtifactSlug({ title }, 'title', id);
  /**
   * A segment of `n` copies of `char`.
   * @param char - Character to repeat.
   * @param n - Segment length.
   * @returns The repeated segment.
   */
  const segment = (char: string, n: number): string => char.repeat(n);

  it('caps derived slugs at 80 characters', () => {
    expect(ARTIFACT_DERIVED_SLUG_MAX_LENGTH).toBe(80);
  });

  it('cuts a long title at the last segment boundary at or below the cap', () => {
    const title = `${segment('a', 50)} ${segment('b', 20)} ${segment('c', 20)}`;
    expect(derive(title)).toBe(`${segment('a', 50)}-${segment('b', 20)}`);
  });

  it('keeps the prefix when the hyphen sits exactly at the cap', () => {
    const title = `${segment('a', 80)} ${segment('b', 5)}`;
    expect(derive(title)).toBe(segment('a', 80));
  });

  it('hard-cuts a first segment longer than the cap', () => {
    expect(derive(`${segment('x', 120)} tail`)).toBe(segment('x', 80));
  });

  it('leaves a slug of exactly 80 characters unchanged', () => {
    const title = `${segment('a', 39)} ${segment('b', 40)}`;
    expect(derive(title)).toHaveLength(80);
    expect(derive(title)).toBe(`${segment('a', 39)}-${segment('b', 40)}`);
  });

  it('strips the trailing hyphen left by the cut', () => {
    const slug = derive(`${segment('a', 79)} ${segment('b', 10)}`);
    expect(slug).toBe(segment('a', 79));
    expect(slug.endsWith('-')).toBe(false);
  });

  it('caps the identity fallback too', () => {
    expect(derive('???', segment('i', 100))).toBe(segment('i', 80));
  });

  it('always yields a capped value that satisfies the slug pattern', () => {
    const titles = [
      'Überarbeitung der Konzeptbaum Prozess Orchestrierung für alle Stationen und Workflows im gesamten System',
      segment('ä', 60),
      segment('a', 81),
      Array.from({ length: 60 }, (_, i) => `w${i}`).join(' '),
    ];
    for (const title of titles) {
      const slug = derive(title);
      expect(slug.length).toBeLessThanOrEqual(ARTIFACT_DERIVED_SLUG_MAX_LENGTH);
      expect(ARTIFACT_SLUG_PATTERN.test(slug)).toBe(true);
    }
  });

  it('does not cap slugify itself', () => {
    expect(slugify(segment('a', 100))).toHaveLength(100);
  });
});

describe('mayArtifactDataCarryProperty', () => {
  const string = { type: 'string' };
  it.each([
    ['plain properties', { type: 'object', properties: { slug: string } }],
    [
      'one union branch',
      {
        oneOf: [
          { type: 'object', properties: { a: string } },
          { type: 'object', properties: { slug: string } },
        ],
      },
    ],
    ['anyOf inside allOf', { allOf: [{ anyOf: [{ type: 'object', properties: { slug: string } }] }] }],
    ['patternProperties', { type: 'object', patternProperties: { '^s': string } }],
    ['a local $ref', { $ref: '#/$defs/v', $defs: { v: { type: 'object', properties: { slug: string } } } }],
    ['a then branch', { if: { required: ['a'] }, then: { properties: { slug: string } } }],
    [
      'required without a properties entry',
      { type: 'object', properties: { name: string }, required: ['name', 'slug'] },
    ],
    ['required in one union branch', { oneOf: [{ required: ['a'] }, { required: ['slug'] }] }],
    ['dependentRequired', { type: 'object', dependentRequired: { marker: ['slug'] } }],
    ['draft-7 dependencies array form', { type: 'object', dependencies: { marker: ['other', 'slug'] } }],
    [
      'draft-7 dependencies object form',
      { type: 'object', dependencies: { marker: { properties: { slug: string } } } },
    ],
    [
      'a nested $defs pointer',
      { $ref: '#/$defs/group/$defs/v', $defs: { group: { $defs: { v: { properties: { slug: string } } } } } },
    ],
    ['an escaped pointer segment', { $ref: '#/$defs/a~1b', $defs: { 'a/b': { required: ['slug'] } } }],
    ['a Unicode property pattern', { type: 'object', patternProperties: { '^\\p{Ll}+$': string } }],
  ])('finds the property in %s', (_label, schema) => {
    expect(mayArtifactDataCarryProperty(schema, 'slug')).toBe(true);
  });

  it('ignores nested object properties and unrelated names', () => {
    expect(
      mayArtifactDataCarryProperty(
        { type: 'object', properties: { meta: { type: 'object', properties: { slug: string } } } },
        'slug',
      ),
    ).toBe(false);
    expect(mayArtifactDataCarryProperty({ type: 'object', properties: { name: string } }, 'slug')).toBe(false);
  });

  it('ignores a nested $ref target that does not carry the property', () => {
    const schema = {
      $ref: '#/$defs/group/$defs/v',
      $defs: { group: { $defs: { v: { properties: { name: string } }, w: { properties: { slug: string } } } } },
    };
    expect(mayArtifactDataCarryProperty(schema, 'slug')).toBe(false);
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

  it('rejects a slug data field declared in only one union variant', () => {
    expect(() =>
      defineArtifactKind({
        kind: 'system',
        description: 'A system.',
        schemaVersion: 1,
        category: 'knowledge',
        titlePath: 'name',
        dataSchema: z.union([
          z.strictObject({ name: z.string(), variant: z.literal('a') }),
          z.strictObject({ name: z.string(), variant: z.literal('b'), slug: z.string() }),
        ]),
      }),
    ).toThrow(/reserved/);
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

  it('rejects a slug requirement hidden behind a dynamic reference', () => {
    const result = ArtifactKindRegistrationSchema.safeParse({
      kind: 'system',
      description: 'A system.',
      schemaVersion: 1,
      category: 'knowledge',
      titlePath: 'name',
      dataSchema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
        allOf: [{ $dynamicRef: '#slugNode' }],
        $defs: { slugNode: { $dynamicAnchor: 'slugNode', required: ['slug'] } },
      },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toContain(
      'Unsupported dynamic reference: use a plain local $ref',
    );
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

describe('payload-time slug guard', () => {
  const reserved = 'Data field slug is reserved: the artifact envelope owns the slug';

  it('rejects data.slug on a live kind whose schema passes unknown keys through', () => {
    const definition = defineArtifactKind({
      kind: 'system',
      description: 'A system.',
      schemaVersion: 1,
      category: 'knowledge',
      titlePath: 'name',
      dataSchema: z.looseObject({ name: z.string() }),
    });
    expect(definition.dataSchema.parse({ name: 'x' })).toEqual({ name: 'x' });
    const result = definition.dataSchema.safeParse({ name: 'x', slug: 'legacy' });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toContainEqual(expect.objectContaining({ path: ['slug'], message: reserved }));
  });

  it('rejects data.slug in the Ajv validators for an open object schema', () => {
    const registration = ArtifactKindRegistrationSchema.parse({
      kind: 'system',
      description: 'A system.',
      schemaVersion: 1,
      category: 'knowledge',
      titlePath: 'name',
      dataSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    });
    const check = compileArtifactDataChecker(registration);
    expect(check({ name: 'x' })).toEqual({ valid: true });
    expect(check({ name: 'x', slug: 'legacy' })).toEqual({
      valid: false,
      issues: [{ path: 'slug', reason: reserved }],
    });
    const validate = compileArtifactDataSchema(registration);
    expect(validate({ name: 'x' })).toBe(true);
    expect(validate({ name: 'x', slug: 'legacy' })).toBe(false);
  });
});
