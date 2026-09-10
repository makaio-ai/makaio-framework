import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { ArtifactKindViewSchema, isArtifactDataPathDeclared } from '../../index.js';
import { defineArtifactKind, type ArtifactDataOf, type ArtifactOf } from '../kind-definition.js';
import { ArtifactKindRegistrationSchema, ArtifactSchemaVersionSchema } from '../schemas.js';
import { defineArtifactLifecycleHooks } from '../lifecycle-hooks.js';
import { readArtifactTitle } from '../kind-paths.js';

const options = {
  kind: 'implementation-plan',
  description: 'Implementation plan.',
  schemaVersion: 1,
  category: 'commitment' as const,
  titlePath: 'topic',
  dataSchema: z.strictObject({ topic: z.string(), status: z.enum(['draft', 'approved']) }),
};

describe('defineArtifactKind', () => {
  it('preserves typed data and numeric versions through registration and revision types', () => {
    const definition = defineArtifactKind({ ...options, indexedFields: ['status'], searchableFields: ['topic'] });
    type PlanData = ArtifactDataOf<typeof definition>;
    const data: PlanData = { topic: 'Payment', status: 'draft' };
    const artifact: ArtifactOf<typeof definition> = {
      kind: definition.kind,
      schemaVersion: 1,
      id: 'plan',
      revision: 'r1',
      data,
      scope: { level: 'global' },
      relations: [],
      actor: { kind: 'agent', id: 'planner' },
      timestamp: 0,
    };
    expect(artifact.schemaVersion + 1).toBe(2);
    expect(definition.dataSchema.parse(data)).toEqual(data);
    expect(ArtifactKindRegistrationSchema.parse(definition.toRegistration())).toMatchObject({
      category: 'commitment',
      titlePath: 'topic',
      schemaVersion: 1,
      indexedFields: ['status'],
      dataSchema: { required: ['topic', 'status'], additionalProperties: false },
    });
  });

  it('validates the complete payload and rejects unreadable titles without trimming valid content', () => {
    const definition = defineArtifactKind(options);
    expect(definition.dataSchema.safeParse({ topic: '  ', status: 'draft' }).success).toBe(false);
    expect(definition.dataSchema.safeParse({ topic: 'Plan', status: 'draft', undeclared: true }).success).toBe(false);
    expect(readArtifactTitle({ topic: ' Payment plan ' }, 'topic')).toBe(' Payment plan ');
    expect(() => readArtifactTitle({}, 'topic')).toThrow();
  });

  it('rejects undeclared raw fields before a stripping authoring schema can discard them', () => {
    const definition = defineArtifactKind({
      ...options,
      titlePath: 'title',
      dataSchema: z.object({
        title: z.string(),
        nested: z.object({ note: z.string() }),
        entries: z.array(z.object({ name: z.string() })),
      }),
    });
    const data = { title: 'Title', nested: { note: 'Note' }, entries: [{ name: 'Entry' }] };
    expect(definition.dataSchema.safeParse(data).success).toBe(true);
    expect(definition.dataSchema.safeParse({ ...data, extra: 1 }).success).toBe(false);
    expect(definition.dataSchema.safeParse({ ...data, nested: { note: 'Note', extra: 1 } }).success).toBe(false);
    expect(definition.dataSchema.safeParse({ ...data, entries: [{ name: 'Entry', extra: 1 }] }).success).toBe(false);
  });

  it('preserves prevalidation rejection messages and paths', () => {
    const definition = defineArtifactKind({
      ...options,
      titlePath: 'title',
      dataSchema: z.object({
        title: z.string(),
        nested: z.object({ count: z.number() }),
      }),
    });
    const input = { title: 'Title', nested: { count: 'invalid', extra: true } };
    const canonical = z.fromJSONSchema(definition.toRegistration().dataSchema).safeParse(input);
    const actual = definition.dataSchema.safeParse(input);
    expect(canonical.success).toBe(false);
    expect(actual.success).toBe(false);
    if (!canonical.success && !actual.success) {
      expect(actual.error.issues.map(({ path, message }) => ({ path, message }))).toEqual(
        canonical.error.issues.map(({ path, message }) => ({ path, message })),
      );
    }
    const wrapped = z.object({ artifact: definition.dataSchema }).safeParse({ artifact: input });
    expect(wrapped.success).toBe(false);
    if (!wrapped.success) {
      expect(wrapped.error.issues.map((issue) => issue.path)).toEqual([
        ['artifact', 'nested', 'count'],
        ['artifact', 'nested'],
      ]);
    }
  });

  it('preserves defaults and live refinements while enforcing the canonical payload shape', () => {
    const definition = defineArtifactKind({
      ...options,
      titlePath: 'title',
      dataSchema: z.object({
        title: z.string().refine((value) => value !== 'Forbidden'),
        status: z.enum(['draft', 'ready']).default('draft'),
        dependencies: z.array(z.string()).default([]),
      }),
    });
    expect(definition.dataSchema.parse({ title: 'Plan' })).toEqual({
      title: 'Plan',
      status: 'draft',
      dependencies: [],
    });
    expect(definition.dataSchema.safeParse({ title: 'Forbidden' }).success).toBe(false);
    expect(() =>
      defineArtifactKind({
        ...options,
        dataSchema: z.object({ topic: z.string().transform((value) => value.length) }),
      }),
    ).toThrow();
  });

  it('runs live dynamic defaults for every parse instead of reusing their serialized example', () => {
    let serial = 0;
    const definition = defineArtifactKind({
      ...options,
      titlePath: 'title',
      dataSchema: z.object({
        title: z.string(),
        serial: z.number().default(() => ++serial),
      }),
    });
    const afterSerialization = serial;
    expect(definition.dataSchema.parse({ title: 'First' }).serial).toBe(afterSerialization + 1);
    expect(definition.dataSchema.parse({ title: 'Second' }).serial).toBe(afterSerialization + 2);
  });

  it('declares its dialect and rejects unsupported live tuple serialization', () => {
    const definition = defineArtifactKind(options);
    expect(definition.toRegistration().dataSchema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    const tuple = z.tuple([z.string(), z.number()]);
    expect(() =>
      defineArtifactKind({ ...options, dataSchema: z.object({ topic: z.string(), position: tuple }) }),
    ).toThrow(/Unsupported tuple serialization/);
    expect(() =>
      defineArtifactKind({
        ...options,
        dataSchema: z.object({ topic: z.string(), entries: z.array(z.object({ position: tuple })) }),
      }),
    ).toThrow(/Unsupported tuple serialization/);
  });

  it('accepts explicitly declared serialized tuple constraints with standards-compliant arity', () => {
    const registration = ArtifactKindRegistrationSchema.parse({
      ...defineArtifactKind(options).toRegistration(),
      titlePath: 'title',
      dataSchema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          title: { type: 'string' },
          position: {
            type: 'array',
            prefixItems: [{ type: 'string' }, { type: 'number' }],
            minItems: 2,
            items: false,
          },
        },
        required: ['title', 'position'],
        additionalProperties: false,
      },
    });
    const validate = new Ajv2020({ strict: false }).compile(registration.dataSchema);
    expect(validate({ title: 'Position', position: ['line', 2] })).toBe(true);
    for (const position of [['line'], ['line', 2, 'extra'], [2, 'line']]) {
      expect(validate({ title: 'Position', position })).toBe(false);
    }
  });

  it('retains kind and schema-version literals for typed consumers', () => {
    const definition = defineArtifactKind({ ...options, kind: 'decision', schemaVersion: 3 });
    expectTypeOf<ArtifactOf<typeof definition>['kind']>().toEqualTypeOf<'decision'>();
    expectTypeOf<ArtifactOf<typeof definition>['schemaVersion']>().toEqualTypeOf<3>();
    expectTypeOf<ArtifactOf<typeof definition>['data']>().toEqualTypeOf<{
      topic: string;
      status: 'draft' | 'approved';
    }>();
    expect(definition.toRegistration().schemaVersion).toBe(3);
  });

  it('combines conjunctive declarations without requiring the title in every branch', () => {
    const definition = defineArtifactKind({
      ...options,
      titlePath: 'title',
      dataSchema: z.intersection(z.looseObject({ title: z.string() }), z.looseObject({ body: z.string() })),
    });
    expect(definition.dataSchema.parse({ title: 'Title', body: 'Body' })).toEqual({ title: 'Title', body: 'Body' });
    const registration = definition.toRegistration();
    const splitRequirement = {
      allOf: [
        { type: 'object', properties: { title: { type: 'string' } } },
        { type: 'object', required: ['title'], properties: { body: { type: 'string' } } },
      ],
    };
    expect(ArtifactKindRegistrationSchema.safeParse({ ...registration, dataSchema: splitRequirement }).success).toBe(
      true,
    );
    const conflicting = { allOf: [splitRequirement, { type: 'object', properties: { title: { type: 'number' } } }] };
    expect(ArtifactKindRegistrationSchema.safeParse({ ...registration, dataSchema: conflicting }).success).toBe(false);
  });

  it('rejects missing, optional, numeric and variant-dependent title fields', () => {
    for (const schema of [
      z.object({ other: z.string() }),
      z.object({ topic: z.string().optional() }),
      z.object({ topic: z.number() }),
      z.union([z.object({ topic: z.string() }), z.object({ other: z.string() })]),
    ]) {
      expect(() => defineArtifactKind<Record<string, unknown>>({ ...options, dataSchema: schema })).toThrow(
        /titlePath/,
      );
    }
  });

  it('accepts shared nested titles in unions and rejects nonexistent index and uniqueness paths', () => {
    const dataSchema = z.union([
      z.object({ type: z.literal('a'), finding: z.object({ summary: z.string() }) }),
      z.object({ type: z.literal('b'), finding: z.object({ summary: z.string() }), rationale: z.string() }),
    ]);
    const definition = defineArtifactKind({ ...options, dataSchema, titlePath: 'finding.summary' });
    expect(definition.toRegistration().titlePath).toBe('finding.summary');
    expect(() => defineArtifactKind({ ...options, indexedFields: ['missing'] })).toThrow();
    expect(() => defineArtifactKind({ ...options, searchableFields: ['/data/topic'] })).toThrow();
    expect(() =>
      defineArtifactKind({ ...options, uniqueness: [{ by: [{ kind: 'data', path: 'missing' }] }] }),
    ).toThrow();
  });

  it.each(['anyOf', 'oneOf'])('retains base field constraints in every %s alternative', (keyword) => {
    const registration = defineArtifactKind(options).toRegistration();
    const dataSchema = {
      type: 'object',
      properties: { topic: { type: 'string' }, status: { type: 'string' } },
      required: ['topic'],
      [keyword]: [
        { properties: { status: { const: 'draft' } }, required: ['status'] },
        { properties: { status: { const: 'approved' } }, required: ['status'] },
      ],
    };
    const result = ArtifactKindRegistrationSchema.parse({
      ...registration,
      dataSchema,
      indexedFields: ['status'],
      searchableFields: ['topic'],
      uniqueness: [{ by: [{ kind: 'data', path: 'topic' }] }],
    });
    const validate = new Ajv2020({ strict: false }).compile(result.dataSchema);
    expect(validate({ topic: 'Plan', status: 'draft' })).toBe(true);
    expect(validate({ status: 'draft' })).toBe(false);
    expect(validate({ topic: 1, status: 'draft' })).toBe(false);

    const conflicting = {
      ...dataSchema,
      [keyword]: [
        { properties: { status: { const: 'draft' } }, required: ['status'] },
        { properties: { topic: { type: 'number' }, status: { const: 'approved' } }, required: ['status'] },
      ],
    };
    expect(ArtifactKindRegistrationSchema.safeParse({ ...registration, dataSchema: conflicting }).success).toBe(false);
    const optionalTitle = { ...dataSchema, required: [] };
    expect(ArtifactKindRegistrationSchema.safeParse({ ...registration, dataSchema: optionalTitle }).success).toBe(
      false,
    );
  });

  it.each(['anyOf', 'oneOf'])('retains base constraints in referenced %s alternatives', (keyword) => {
    const registration = defineArtifactKind(options).toRegistration();
    const dataSchema = {
      type: 'object',
      properties: { topic: { type: 'string' } },
      required: ['topic'],
      [keyword]: [{ $ref: '#/$defs/draft' }, { $ref: '#/$defs/approved' }],
      $defs: {
        draft: { properties: { status: { const: 'draft' } }, required: ['status'] },
        approved: { properties: { status: { const: 'approved' } }, required: ['status'] },
      },
    };
    const result = ArtifactKindRegistrationSchema.parse({ ...registration, dataSchema });
    const validate = new Ajv2020({ strict: false }).compile(result.dataSchema);
    expect(validate({ topic: 'Plan', status: 'draft' })).toBe(true);
    expect(validate({ status: 'draft' })).toBe(false);
    const conflicting = {
      ...dataSchema,
      $defs: {
        ...dataSchema.$defs,
        approved: { properties: { topic: { type: 'number' }, status: { const: 'approved' } }, required: ['status'] },
      },
    };
    expect(ArtifactKindRegistrationSchema.safeParse({ ...registration, dataSchema: conflicting }).success).toBe(false);
  });

  it.each(['anyOf', 'oneOf'])('combines 2020 reference siblings within %s alternatives', (keyword) => {
    const registration = defineArtifactKind(options).toRegistration();
    const dataSchema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { topic: { type: 'string' } },
      required: ['topic'],
      [keyword]: ['draft', 'approved'].map((status) => ({
        $ref: '#/$defs/common',
        properties: { status: { const: status } },
        required: ['status'],
      })),
      $defs: { common: { type: 'object' } },
    };
    const result = ArtifactKindRegistrationSchema.parse({ ...registration, dataSchema, indexedFields: ['status'] });
    const validate = new Ajv2020({ strict: false }).compile(result.dataSchema);
    expect(validate({ topic: 'Plan', status: 'draft' })).toBe(true);
    expect(validate({ topic: 'Plan' })).toBe(false);
  });

  it('preserves reference sibling requirements, nested paths and conflicts in 2020 schemas', () => {
    const registration = defineArtifactKind(options).toRegistration();
    const dataSchema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $ref: '#/$defs/base',
      required: ['topic'],
      $defs: { base: { type: 'object', properties: { topic: { type: 'string' } } } },
    };
    expect(ArtifactKindRegistrationSchema.safeParse({ ...registration, dataSchema }).success).toBe(true);
    expect(
      ArtifactKindRegistrationSchema.safeParse({
        ...registration,
        dataSchema: { ...dataSchema, properties: { topic: { type: 'number' } } },
      }).success,
    ).toBe(false);
    const nested = {
      $schema: dataSchema.$schema,
      type: 'object',
      properties: { meta: { $ref: '#/$defs/base', required: ['topic'] } },
      required: ['meta'],
      $defs: dataSchema.$defs,
    };
    expect(
      ArtifactKindRegistrationSchema.safeParse({
        ...registration,
        dataSchema: nested,
        titlePath: 'meta.topic',
        searchableFields: ['meta.topic'],
        uniqueness: [{ by: [{ kind: 'data', path: 'meta.topic' }] }],
      }).success,
    ).toBe(true);
    const conjunction = {
      $schema: dataSchema.$schema,
      allOf: [{ $ref: '#/$defs/base', required: ['topic'] }, { type: 'object' }],
      $defs: dataSchema.$defs,
    };
    expect(ArtifactKindRegistrationSchema.safeParse({ ...registration, dataSchema: conjunction }).success).toBe(true);
  });

  it.each([
    undefined,
    'http://json-schema.org/draft-07/schema#',
  ])('ignores reference siblings for draft-7 dialect %s', (dialect) => {
    const registration = defineArtifactKind(options).toRegistration();
    const dataSchema = {
      ...(dialect === undefined ? {} : { $schema: dialect }),
      $ref: '#/definitions/base',
      properties: { status: { type: 'string' } },
      definitions: { base: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] } },
    };
    expect(ArtifactKindRegistrationSchema.safeParse({ ...registration, dataSchema }).success).toBe(true);
    expect(
      ArtifactKindRegistrationSchema.safeParse({ ...registration, dataSchema, indexedFields: ['status'] }).success,
    ).toBe(false);
    expect(
      ArtifactKindRegistrationSchema.safeParse({
        ...registration,
        dataSchema: {
          ...dataSchema,
          required: ['topic'],
          definitions: { base: { type: 'object', properties: { topic: { type: 'string' } } } },
        },
      }).success,
    ).toBe(false);
  });

  it('resolves reference targets containing unions and rejects selected reference cycles', () => {
    const registration = defineArtifactKind(options).toRegistration();
    const dataSchema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $ref: '#/$defs/variants',
      type: 'object',
      properties: { topic: { type: 'string' } },
      required: ['topic'],
      $defs: {
        variants: {
          anyOf: [
            { properties: { status: { const: 'draft' } }, required: ['status'] },
            { properties: { status: { const: 'approved' } }, required: ['status'] },
          ],
        },
      },
    };
    expect(
      ArtifactKindRegistrationSchema.safeParse({ ...registration, dataSchema, indexedFields: ['status'] }).success,
    ).toBe(true);
    for (const definitions of [
      { variants: { $ref: '#/$defs/variants', required: ['topic'] } },
      { variants: { $ref: '#/$defs/other' }, other: { $ref: '#/$defs/variants', required: ['topic'] } },
    ]) {
      expect(
        ArtifactKindRegistrationSchema.safeParse({ ...registration, dataSchema: { ...dataSchema, $defs: definitions } })
          .success,
      ).toBe(false);
    }
    expect(
      ArtifactKindRegistrationSchema.safeParse({
        ...registration,
        dataSchema: {
          $schema: dataSchema.$schema,
          type: 'object',
          properties: { topic: { type: 'string' } },
          required: ['topic'],
          $defs: { unused: { $ref: '#/$defs/unused' } },
        },
      }).success,
    ).toBe(true);
  });

  it.each(['anyOf', 'oneOf'])('rejects unsupported boolean %s alternatives explicitly', (keyword) => {
    const registration = defineArtifactKind(options).toRegistration();
    expect(() =>
      ArtifactKindRegistrationSchema.parse({
        ...registration,
        dataSchema: { ...registration.dataSchema, [keyword]: [true, false] },
      }),
    ).toThrow(/Unsupported boolean union alternative/);
  });

  it('keeps schema generations inside the safe integer range enforced by Zod 4', () => {
    expect(ArtifactSchemaVersionSchema.parse(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    for (const schemaVersion of [Number.MAX_SAFE_INTEGER + 1, 1e20]) {
      expect(ArtifactSchemaVersionSchema.safeParse(schemaVersion).success).toBe(false);
      expect(
        ArtifactKindRegistrationSchema.safeParse({ ...defineArtifactKind(options).toRegistration(), schemaVersion })
          .success,
      ).toBe(false);
    }
  });

  it.each([
    'properties',
    'patternProperties',
    '$defs',
    'definitions',
    'dependentSchemas',
    'dependencies',
  ])('rejects unsupported async schemas in schema-map positions (%s)', (keyword) => {
    const registration = defineArtifactKind(options).toRegistration();
    const result = ArtifactKindRegistrationSchema.safeParse({
      ...registration,
      dataSchema: {
        ...registration.dataSchema,
        [keyword]: {
          ...(keyword === 'properties' ? { topic: { type: 'string' }, status: { type: 'string' } } : {}),
          hidden: { $async: true },
        },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ['dataSchema', keyword, 'hidden', '$async'],
          message: 'Asynchronous artifact schemas are not supported',
        }),
      );
  });

  it.each([
    'allOf',
    'anyOf',
    'oneOf',
    'prefixItems',
    'items',
  ])('rejects named anchors in schema-array positions (%s)', (keyword) => {
    const registration = defineArtifactKind(options).toRegistration();
    const result = ArtifactKindRegistrationSchema.safeParse({
      ...registration,
      dataSchema: { ...registration.dataSchema, [keyword]: [{ $anchor: 'hidden' }] },
    });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ['dataSchema', keyword, 0, '$anchor'],
        }),
      );
  });

  it.each([
    'items',
    'additionalItems',
    'additionalProperties',
    'unevaluatedItems',
    'unevaluatedProperties',
    'propertyNames',
    'contains',
    'not',
    'if',
    'then',
    'else',
    'contentSchema',
  ])('rejects named fragment references in single-schema positions (%s)', (keyword) => {
    const registration = defineArtifactKind(options).toRegistration();
    const result = ArtifactKindRegistrationSchema.safeParse({
      ...registration,
      dataSchema: { ...registration.dataSchema, [keyword]: { $ref: '#hidden' } },
    });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ['dataSchema', keyword, '$ref'],
        }),
      );
  });

  it('rejects async registration at the root and reports named title references explicitly', () => {
    const registration = defineArtifactKind(options).toRegistration();
    expect(() =>
      ArtifactKindRegistrationSchema.parse({
        ...registration,
        dataSchema: { ...registration.dataSchema, $async: true },
      }),
    ).toThrow(/Asynchronous artifact schemas/);
    const result = ArtifactKindRegistrationSchema.safeParse({
      ...registration,
      dataSchema: {
        ...registration.dataSchema,
        properties: { topic: { $ref: '#title' } },
        $defs: { title: { $anchor: 'title', type: 'string' } },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ['dataSchema', 'properties', 'topic', '$ref'],
          message: 'Named schema references are not supported; use local JSON Pointer references',
        }),
      );
  });

  it('does not mistake literal values or property names for unsupported schema capabilities', () => {
    const registration = defineArtifactKind(options).toRegistration();
    const literal = { $anchor: 'literal', $async: true, $ref: '#literal' };
    const dataSchema = {
      ...registration.dataSchema,
      $async: false,
      default: literal,
      examples: [literal],
      const: literal,
      enum: [literal],
      properties: {
        topic: { type: 'string' },
        status: { type: 'string' },
        $anchor: { type: 'string' },
        $async: { type: 'boolean' },
        $ref: { type: 'string' },
        nested: { type: 'object', const: literal },
      },
      dependencies: { topic: ['status'] },
      $defs: { $anchor: { type: 'string' } },
    };
    expect(ArtifactKindRegistrationSchema.safeParse({ ...registration, dataSchema }).success).toBe(true);
  });

  it.each([
    'https://example.com/common.json#/$defs/item',
    'common.json#/$defs/item',
  ])('rejects nonlocal references even on an unrelated optional property (%s)', (reference) => {
    const registration = defineArtifactKind(options).toRegistration();
    const result = ArtifactKindRegistrationSchema.safeParse({
      ...registration,
      dataSchema: {
        type: 'object',
        properties: { topic: { type: 'string' }, optional: { $ref: reference } },
        required: ['topic'],
      },
    });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ['dataSchema', 'properties', 'optional', '$ref'],
          message:
            'Only fragment schema references are supported; absolute and document-relative references are outside the artifact registration profile',
        }),
      );
  });

  it('deliberately excludes self-contained absolute references although AJV can resolve them', () => {
    const registration = defineArtifactKind(options).toRegistration();
    const dataSchema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://example.com/self.json',
      type: 'object',
      properties: { topic: { type: 'string' }, optional: { $ref: 'https://example.com/self.json#/$defs/item' } },
      required: ['topic'],
      $defs: { item: { type: 'string' } },
    };
    expect(
      new Ajv2020({ strict: false, strictSchema: true }).compile(dataSchema)({ topic: 'Plan', optional: 'Value' }),
    ).toBe(true);
    expect(() => ArtifactKindRegistrationSchema.parse({ ...registration, dataSchema })).toThrow(
      /Only fragment schema references are supported/,
    );
  });

  it('preserves local definitions and nonlocal reference strings in literal data', () => {
    const registration = defineArtifactKind(options).toRegistration();
    const literal = { $ref: 'https://example.com/external.json' };
    const dataSchema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        topic: { $ref: '#/$defs/title' },
        $ref: { type: 'string' },
        metadata: { type: 'object', const: literal, default: literal, examples: [literal], enum: [literal] },
      },
      required: ['topic'],
      $defs: { title: { type: 'string' } },
    };
    const accepted = ArtifactKindRegistrationSchema.parse({ ...registration, dataSchema });
    const validate = new Ajv2020({ strict: false, strictSchema: true }).compile(accepted.dataSchema);
    expect(validate({ topic: 'Plan', $ref: 'common.json', metadata: literal })).toBe(true);
    expect(validate({ topic: 1 })).toBe(false);
  });

  it.each([
    { name: 'missing', reference: '#/$defs/missing', data: {} },
    { name: 'string', reference: '#/default/value', data: { default: { value: 'literal' } } },
    { name: 'number', reference: '#/default/value', data: { default: { value: 1 } } },
    { name: 'null', reference: '#/default/value', data: { default: { value: null } } },
    { name: 'array', reference: '#/default/value', data: { default: { value: [] } } },
  ])('rejects a $name fragment target on an unrelated optional property', ({ reference, data }) => {
    const registration = defineArtifactKind(options).toRegistration();
    const result = ArtifactKindRegistrationSchema.safeParse({
      ...registration,
      dataSchema: {
        type: 'object',
        properties: { topic: { type: 'string' }, optional: { $ref: reference } },
        required: ['topic'],
        ...data,
      },
    });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ['dataSchema', 'properties', 'optional', '$ref'],
          message: 'Fragment schema reference must resolve to an existing object or boolean schema',
        }),
      );
  });

  it('validates immediate fragment targets without following valid recursive references', () => {
    const registration = defineArtifactKind(options).toRegistration();
    const dataSchema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        topic: { type: 'string' },
        root: { $ref: '#' },
        branch: { $ref: '#/$defs/node' },
        anything: { $ref: '#/$defs/allow' },
        forbidden: { $ref: '#/$defs/deny' },
        escaped: { $ref: '#/$defs/a~1b~0c' },
      },
      required: ['topic'],
      $defs: {
        node: { type: 'object', properties: { child: { $ref: '#/$defs/node' } } },
        allow: true,
        deny: false,
        'a/b~c': { type: 'string' },
      },
    };
    const accepted = ArtifactKindRegistrationSchema.parse({ ...registration, dataSchema });
    const validate = new Ajv2020({ strict: false, strictSchema: true }).compile(accepted.dataSchema);
    expect(
      validate({ topic: 'Plan', root: { topic: 'Child' }, branch: { child: {} }, anything: 1, escaped: 'Value' }),
    ).toBe(true);
    expect(validate({ topic: 'Plan', forbidden: true })).toBe(false);
  });

  it.each([
    42,
    null,
    true,
    {},
    [],
  ])('rejects a non-string schema reference %j while preserving literal data', (reference) => {
    const registration = defineArtifactKind(options).toRegistration();
    const result = ArtifactKindRegistrationSchema.safeParse({
      ...registration,
      dataSchema: {
        type: 'object',
        properties: { topic: { type: 'string' }, optional: { $ref: reference } },
        required: ['topic'],
      },
    });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ['dataSchema', 'properties', 'optional', '$ref'],
          message: 'Schema reference must be a string',
        }),
      );
    const literal = { $ref: reference };
    expect(
      ArtifactKindRegistrationSchema.safeParse({
        ...registration,
        dataSchema: {
          ...registration.dataSchema,
          default: literal,
          const: literal,
          examples: [literal],
          enum: [literal],
        },
      }).success,
    ).toBe(true);
  });

  it('only accepts data schema dialects supported by the artifact writers', () => {
    const registration = defineArtifactKind(options).toRegistration();
    for (const dialect of [
      undefined,
      'http://json-schema.org/draft-07/schema#',
      'https://json-schema.org/draft/2020-12/schema',
    ]) {
      const { $schema: _dialect, ...dataSchema } = registration.dataSchema;
      expect(
        ArtifactKindRegistrationSchema.safeParse({
          ...registration,
          dataSchema: { ...dataSchema, ...(dialect === undefined ? {} : { $schema: dialect }) },
        }).success,
      ).toBe(true);
    }
    for (const dialect of [
      'https://json-schema.org/draft/2019-09/schema',
      'https://example.org/schema',
      '',
      2020,
      null,
    ]) {
      const result = ArtifactKindRegistrationSchema.safeParse({
        ...registration,
        dataSchema: { ...registration.dataSchema, $schema: dialect },
      });
      expect(result.success).toBe(false);
      if (!result.success)
        expect(result.error.issues).toContainEqual(expect.objectContaining({ path: ['dataSchema', '$schema'] }));
    }
  });

  it.each([
    { name: 'direct', schema: { properties: { topic: { type: 'string' } }, required: ['topic'] } },
    {
      name: 'reference',
      schema: {
        $ref: '#/$defs/root',
        $defs: { root: { properties: { topic: { type: 'string' } }, required: ['topic'] } },
      },
    },
    {
      name: 'conjunction',
      schema: { allOf: [{ properties: { topic: { type: 'string' } } }, { required: ['topic'] }] },
    },
    {
      name: 'variants',
      schema: {
        anyOf: [
          { properties: { topic: { type: 'string' }, state: { const: 'draft' } }, required: ['topic', 'state'] },
          { properties: { topic: { type: 'string' }, state: { const: 'ready' } }, required: ['topic', 'state'] },
        ],
      },
    },
  ])('uses the Artifact data object guarantee for an implicit $name root schema', ({ schema }) => {
    const registration = defineArtifactKind(options).toRegistration();
    const accepted = ArtifactKindRegistrationSchema.parse({
      ...registration,
      dataSchema: schema,
      indexedFields: ['topic'],
      searchableFields: ['topic'],
      uniqueness: [{ by: [{ kind: 'data', path: 'topic' }] }],
    });
    expect(accepted.dataSchema).toEqual(schema);
    const validate = new Ajv2020({ strict: false }).compile({ type: 'object', ...schema });
    expect(validate({ topic: 'Plan', state: 'draft' })).toBe(true);
    expect(validate({ state: 'draft' })).toBe(false);
    expect(validate('scalar')).toBe(false);
  });

  it.each([
    { name: 'direct', nested: { properties: { topic: { type: 'string' } }, required: ['topic'] } },
    { name: 'reference', nested: { $ref: '#/$defs/nested' } },
    {
      name: 'conjunction',
      nested: { allOf: [{ properties: { topic: { type: 'string' } } }, { required: ['topic'] }] },
    },
  ])('does not carry the root object guarantee into an implicit $name nested schema', ({ nested }) => {
    const registration = defineArtifactKind(options).toRegistration();
    const dataSchema = {
      type: 'object',
      properties: { metadata: nested },
      required: ['metadata'],
      $defs: { nested: { properties: { topic: { type: 'string' } }, required: ['topic'] } },
    };
    const validate = new Ajv2020({ strict: false }).compile(dataSchema);
    expect(validate({ metadata: 'scalar' })).toBe(true);
    expect(
      ArtifactKindRegistrationSchema.safeParse({ ...registration, titlePath: 'metadata.topic', dataSchema }).success,
    ).toBe(false);
  });

  it('validates additive cardinalities and category-compatible uniqueness declarations', () => {
    const definition = defineArtifactKind({
      ...options,
      relations: [{ relationType: 'implements', targetKinds: ['requirement'], minItems: 1, maxItems: 2 }],
      uniqueness: [
        {
          by: [
            { kind: 'data', path: 'topic' },
            { kind: 'relation-target', relationType: 'targets' },
          ],
          lifecycleStates: ['decided'],
        },
      ],
      evidenceRequirements: { minItems: 0 },
    });
    const registration = definition.toRegistration();
    expect(registration.relations?.[0]?.maxItems).toBe(2);
    registration.relations?.push({ relationType: 'mutated', minItems: 0 });
    expect(definition.toRegistration().relations).toHaveLength(1);
    expect(() =>
      defineArtifactKind({ ...options, relations: [{ relationType: 'x', minItems: 2, maxItems: 1 }] }),
    ).toThrow();
    expect(() => defineArtifactKind({ ...options, uniqueness: [{ by: [] }] })).toThrow();
    expect(() =>
      defineArtifactKind({
        ...options,
        uniqueness: [{ by: [{ kind: 'data', path: 'topic' }], lifecycleStates: ['valid'] }],
      }),
    ).toThrow();
    expect(() =>
      defineArtifactKind({
        ...options,
        category: 'record',
        uniqueness: [{ by: [{ kind: 'data', path: 'topic' }], lifecycleStates: ['decided'] }],
      }),
    ).toThrow();
  });

  it('resolves local schema references and rejects reference cycles', () => {
    const registration = defineArtifactKind(options).toRegistration();
    const dataSchema = {
      type: 'object',
      properties: { topic: { $ref: '#/$defs/title' } },
      required: ['topic'],
      $defs: { title: { type: 'string' } },
    };
    expect(ArtifactKindRegistrationSchema.safeParse({ ...registration, dataSchema }).success).toBe(true);
    const cyclic = { ...dataSchema, $defs: { title: { $ref: '#/$defs/title' } } };
    expect(ArtifactKindRegistrationSchema.safeParse({ ...registration, dataSchema: cyclic }).success).toBe(false);
  });

  it('rejects separately closed intersections instead of masking their wire semantics', () => {
    const schema = z.intersection(z.object({ title: z.string() }), z.object({ body: z.string() }));
    const wire = z.toJSONSchema(schema);
    const validate = new Ajv2020({ strict: false }).compile(wire);
    const payload = { title: 'Title', body: 'Body' };
    expect(schema.safeParse(payload).success).toBe(true);
    expect(validate(payload)).toBe(false);
    expect(validate.errors?.some((error) => error.keyword === 'additionalProperties')).toBe(true);
    expect(() => defineArtifactKind({ ...options, titlePath: 'title', dataSchema: schema })).toThrow(
      /Unsupported intersection/,
    );
    const registration = defineArtifactKind(options).toRegistration();
    expect(
      ArtifactKindRegistrationSchema.safeParse({ ...registration, titlePath: 'title', dataSchema: wire }).success,
    ).toBe(false);
    expect(() =>
      defineArtifactKind({ ...options, dataSchema: z.object({ topic: z.string(), details: schema }) }),
    ).toThrow(/Unsupported intersection/);
  });

  it('rejects implicit nested closed intersections even when outer property names agree', () => {
    const strictLeft = z.object({ title: z.string(), details: z.object({ left: z.string() }) });
    const strictRight = z.object({ title: z.string(), details: z.object({ right: z.string() }) });
    const schemas = [z.intersection(strictLeft, strictRight), z.intersection(strictLeft.loose(), strictRight.loose())];
    const payload = { title: 'Title', details: { left: 'Left', right: 'Right' } };
    for (const schema of schemas) {
      const wire = z.toJSONSchema(schema);
      const validate = new Ajv2020({ strict: false }).compile(wire);
      expect(schema.safeParse(payload).success).toBe(true);
      expect(validate(payload)).toBe(false);
      expect(validate.errors?.[0]?.instancePath).toBe('/details');
      expect(() => defineArtifactKind({ ...options, titlePath: 'title', dataSchema: schema })).toThrow(
        /Unsupported intersection/,
      );
    }
  });

  it('keeps valid open intersections equivalent to a standards validator', () => {
    const definition = defineArtifactKind({
      ...options,
      titlePath: 'title',
      dataSchema: z.intersection(z.looseObject({ title: z.string() }), z.looseObject({ body: z.string() })),
    });
    const validate = new Ajv2020({ strict: false }).compile(definition.toRegistration().dataSchema);
    for (const payload of [{ title: 'Title', body: 'Body' }, { title: 'Title' }, { title: 1, body: 'Body' }]) {
      expect(definition.dataSchema.safeParse(payload).success).toBe(validate(payload));
    }
  });

  it('keeps function-valued hooks live and excludes them from transport', () => {
    const handler = vi.fn();
    const definition = defineArtifactKind({
      ...options,
      hooks: defineArtifactLifecycleHooks({ hooks: [{ id: 'plan.validate', event: 'beforeCreate', handler }] }),
    });
    expect(definition.hooks?.hooks[0]?.handler).toBe(handler);
    expect(definition.toRegistration()).not.toHaveProperty('hooks');
  });

  it('serializes named original-field views independently from live kind behavior', () => {
    const definition = defineArtifactKind({
      ...options,
      titlePath: 'subject',
      dataSchema: z.strictObject({
        subject: z.string(),
        statement: z.string(),
        details: z.strictObject({ rationale: z.string() }),
        rejectedAlternatives: z.array(z.strictObject({ alternative: z.string(), reason: z.string() })),
      }),
      views: {
        compact: { fields: ['subject', 'statement'] },
        detailed: { fields: ['subject', 'details.rationale', 'rejectedAlternatives'] },
      },
    });

    const registration = definition.toRegistration();
    expect(registration.views).toEqual({
      compact: { fields: ['subject', 'statement'] },
      detailed: { fields: ['subject', 'details.rationale', 'rejectedAlternatives'] },
    });
    registration.views?.compact?.fields.push('details.rationale');
    expect(definition.toRegistration().views?.compact?.fields).toEqual(['subject', 'statement']);
  });

  it('validates named view paths against object properties and permits whole terminal arrays', () => {
    const registration = defineArtifactKind({
      ...options,
      titlePath: 'subject',
      dataSchema: z.strictObject({
        subject: z.string(),
        details: z.strictObject({ rationale: z.string() }),
        rejectedAlternatives: z.array(z.strictObject({ alternative: z.string(), reason: z.string() })),
      }),
      views: { compact: { fields: ['details.rationale', 'rejectedAlternatives'] } },
    }).toRegistration();

    expect(isArtifactDataPathDeclared(registration.dataSchema, 'details.rationale')).toBe(true);
    expect(isArtifactDataPathDeclared(registration.dataSchema, 'rejectedAlternatives')).toBe(true);
    expect(isArtifactDataPathDeclared(registration.dataSchema, 'rejectedAlternatives.reason')).toBe(false);

    const result = ArtifactKindRegistrationSchema.safeParse({
      ...registration,
      views: { compact: { fields: ['rejectedAlternatives.reason'] } },
    });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ['views', 'compact', 'fields', 0],
          message: 'Data path rejectedAlternatives.reason must select a declared field',
        }),
      );
  });

  it('does not treat inherited property names as declared paths', () => {
    const registration = defineArtifactKind(options).toRegistration();
    expect(isArtifactDataPathDeclared(registration.dataSchema, '__proto__')).toBe(false);

    const rejected = ArtifactKindRegistrationSchema.safeParse({
      ...registration,
      views: { compact: { fields: ['__proto__'] } },
    });
    expect(rejected.success).toBe(false);

    const ownProperties = JSON.parse('{"title":{"type":"string"},"__proto__":{"type":"string"}}') as Record<
      string,
      unknown
    >;
    expect(isArtifactDataPathDeclared({ type: 'object', properties: ownProperties }, '__proto__')).toBe(true);
  });

  it('allows boolean schema terminals but does not traverse through them', () => {
    const booleanSchema = {
      type: 'object',
      properties: {
        topic: { type: 'string' },
        allowed: true,
        denied: false,
        allowedReference: { $ref: '#/$defs/allowed' },
        deniedReference: { $ref: '#/$defs/denied' },
      },
      required: ['topic'],
      $defs: { allowed: true, denied: false },
    };
    const registration = ArtifactKindRegistrationSchema.parse({
      ...defineArtifactKind(options).toRegistration(),
      dataSchema: booleanSchema,
      views: { compact: { fields: ['allowed', 'denied', 'allowedReference', 'deniedReference'] } },
    });

    for (const path of registration.views?.compact?.fields ?? []) {
      expect(isArtifactDataPathDeclared(registration.dataSchema, path)).toBe(true);
    }
    expect(isArtifactDataPathDeclared(registration.dataSchema, 'allowed.nested')).toBe(false);
    expect(
      ArtifactKindRegistrationSchema.safeParse({
        ...registration,
        dataSchema: { ...booleanSchema, properties: { ...booleanSchema.properties, topic: true } },
      }).success,
    ).toBe(false);
  });

  it.each([
    { name: 'true', target: true },
    { name: 'false', target: false },
  ])('keeps a 2020-12 boolean $ref terminal when it has sibling constraints ($name)', ({ target }) => {
    const registration = ArtifactKindRegistrationSchema.parse({
      ...defineArtifactKind(options).toRegistration(),
      dataSchema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          topic: { type: 'string' },
          referenced: { $ref: '#/$defs/target', description: 'A constrained boolean reference.' },
        },
        required: ['topic'],
        $defs: { target },
      },
      views: { compact: { fields: ['referenced'] } },
    });

    expect(isArtifactDataPathDeclared(registration.dataSchema, 'referenced')).toBe(true);
    expect(isArtifactDataPathDeclared(registration.dataSchema, 'referenced.nested')).toBe(false);
  });

  it('allows extensible view names and optional declared fields', () => {
    const definition = defineArtifactKind({
      ...options,
      titlePath: 'subject',
      dataSchema: z.strictObject({
        subject: z.string(),
        details: z.strictObject({ rationale: z.string() }).optional(),
      }),
      views: { 'implementation-planner': { fields: ['subject', 'details.rationale'] } },
    });

    expect(definition.toRegistration().views).toEqual({
      'implementation-planner': { fields: ['subject', 'details.rationale'] },
    });
  });

  it('reserves full for the generic complete-payload view', () => {
    const registration = defineArtifactKind(options).toRegistration();
    expect(ArtifactKindViewSchema.safeParse({ fields: [] }).success).toBe(false);
    const result = ArtifactKindRegistrationSchema.safeParse({
      ...registration,
      views: { full: { fields: ['topic'] } },
    });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ['views', 'full'],
          message: 'Artifact kind view full is reserved for the generic complete-payload view',
        }),
      );
  });

  it('rejects obsolete registration metadata instead of silently accepting it', () => {
    const registration = defineArtifactKind(options).toRegistration();
    for (const key of [
      'scopeSchema',
      'observationSchema',
      'status',
      'lifecycle',
      'projection',
      'defaultContext',
      'discriminator',
      'conflictPolicy',
    ]) {
      expect(ArtifactKindRegistrationSchema.safeParse({ ...registration, [key]: {} }).success).toBe(false);
    }
    for (const schemaVersion of ['1', 0, -1, 1.5]) {
      expect(ArtifactKindRegistrationSchema.safeParse({ ...registration, schemaVersion }).success).toBe(false);
    }
  });
});
