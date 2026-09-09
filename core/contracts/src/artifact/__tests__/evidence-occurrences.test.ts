import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import Ajv2020 from 'ajv/dist/2020.js';

import { defineArtifactKind } from '../kind-definition.js';
import { extractEvidenceOccurrences } from '../evidence-occurrences.js';
import { ARTIFACT_VALUE_TYPE_KEYWORD, EVIDENCE_VALUE_TYPE, EvidenceValueSchema } from '../evidence.js';

const evidence = {
  source: {
    kind: 'git-file' as const,
    repository: 'makaio-ai/makaio',
    path: 'src/index.ts',
    commit: '0123456789abcdef0123456789abcdef01234567',
  },
  location: { kind: 'lines' as const, startLine: 12, lineCount: 4 },
};

function registrationFor(dataSchema: z.ZodType<Record<string, unknown>>) {
  return defineArtifactKind({
    kind: 'review',
    description: 'Review with evidence-backed findings.',
    schemaVersion: 1,
    category: 'record',
    titlePath: 'title',
    dataSchema,
  }).toRegistration();
}

function unmarkedEvidenceSchema(): Record<string, unknown> {
  const { [ARTIFACT_VALUE_TYPE_KEYWORD]: _marker, ...schema } = z.toJSONSchema(EvidenceValueSchema);
  return schema;
}

const extractionOptions = {
  matchesSchema: (root: Record<string, unknown>, pointer: string, value: unknown) => {
    const ajv = new Ajv2020({ strict: false });
    const id = 'urn:makaio:test-root';
    ajv.addSchema({ ...root, $id: id });
    return ajv.validate({ $ref: `${id}#${pointer}` }, value);
  },
};

describe('extractEvidenceOccurrences', () => {
  it('discovers reused EvidenceValue schemas through arrays and preserves JSON Pointer locations', () => {
    const registration = registrationFor(
      z.strictObject({
        title: z.string(),
        findings: z.array(z.strictObject({ id: z.string(), evidence: z.array(EvidenceValueSchema) })),
      }),
    );
    const data = {
      title: 'Review',
      findings: [
        { id: 'f1', evidence: [] },
        { id: 'f2', evidence: [evidence] },
      ],
    };

    expect(extractEvidenceOccurrences(registration.dataSchema, data, extractionOptions)).toEqual([
      { evidence, dataPath: '/data/findings/1/evidence/0' },
    ]);
  });

  it('follows local references and only traverses matching union branches', () => {
    const markedEvidence = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $defs: {
        evidence: {
          ...z.toJSONSchema(EvidenceValueSchema),
          [ARTIFACT_VALUE_TYPE_KEYWORD]: EVIDENCE_VALUE_TYPE,
        },
      },
      type: 'object',
      properties: {
        title: { type: 'string' },
        payload: {
          oneOf: [
            {
              type: 'object',
              properties: { kind: { const: 'finding' }, evidence: { $ref: '#/$defs/evidence' } },
              required: ['kind', 'evidence'],
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: { kind: { const: 'example' }, evidence: unmarkedEvidenceSchema() },
              required: ['kind', 'evidence'],
              additionalProperties: false,
            },
          ],
        },
      },
    };
    const actual = { title: 'Review', payload: { kind: 'finding', evidence } };
    const illustrative = { title: 'Review', payload: { kind: 'example', evidence } };

    const seenDialects: unknown[] = [];
    const unionOptions = {
      matchesSchema: (root: Record<string, unknown>, pointer: string, value: unknown) => {
        seenDialects.push(root['$schema']);
        return extractionOptions.matchesSchema(root, pointer, value);
      },
    };
    expect(extractEvidenceOccurrences(markedEvidence, actual, unionOptions)).toEqual([
      { evidence, dataPath: '/data/payload/evidence' },
    ]);
    expect(extractEvidenceOccurrences(markedEvidence, illustrative, unionOptions)).toEqual([]);
    expect(seenDialects.every((dialect) => dialect === 'https://json-schema.org/draft/2020-12/schema')).toBe(true);
  });

  it('ignores evidence-shaped data and schema examples without the semantic annotation', () => {
    const schema = {
      type: 'object',
      properties: {
        title: { type: 'string' },
        example: { ...unmarkedEvidenceSchema(), examples: [evidence] },
      },
    };

    expect(extractEvidenceOccurrences(schema, { title: 'Guide', example: evidence }, extractionOptions)).toEqual([]);
  });

  it('fails visibly for invalid marked values and unresolved references', () => {
    expect(() =>
      extractEvidenceOccurrences(
        { type: 'object', properties: { evidence: { [ARTIFACT_VALUE_TYPE_KEYWORD]: EVIDENCE_VALUE_TYPE } } },
        { evidence: { source: { kind: 'git-file' } } },
        extractionOptions,
      ),
    ).toThrow('Invalid schema-declared evidence at /data/evidence');
    expect(() =>
      extractEvidenceOccurrences(
        { type: 'object', properties: { evidence: { $ref: '#/$defs/missing' } } },
        { evidence },
        extractionOptions,
      ),
    ).toThrow('Cannot resolve local schema reference #/$defs/missing at /data/evidence');
  });

  it('accepts local references to boolean schemas without treating them as unresolved', () => {
    expect(
      extractEvidenceOccurrences(
        {
          type: 'object',
          properties: { allowed: { $ref: '#/$defs/anything' }, denied: { $ref: '#/$defs/nothing' } },
          $defs: { anything: true, nothing: false },
        },
        { allowed: 'value', denied: 'kind validation rejects this before extraction' },
        extractionOptions,
      ),
    ).toEqual([]);
  });

  it('keeps full root context when selecting referenced union branches', () => {
    const schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        payload: { oneOf: [{ $ref: '#/$defs/finding' }, { type: 'string' }] },
      },
      $defs: {
        finding: {
          type: 'object',
          properties: { evidence: z.toJSONSchema(EvidenceValueSchema) },
          required: ['evidence'],
        },
      },
    };
    expect(extractEvidenceOccurrences(schema, { payload: { evidence } }, extractionOptions)).toEqual([
      { evidence, dataPath: '/data/payload/evidence' },
    ]);
  });

  it('traverses tuple, pattern, and additional-property schemas', () => {
    const marked = z.toJSONSchema(EvidenceValueSchema);
    expect(
      extractEvidenceOccurrences(
        {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          properties: {
            tuple: { type: 'array', prefixItems: [{ type: 'string' }, marked] },
            labels: { type: 'object', patternProperties: { '^known-': marked }, additionalProperties: marked },
          },
        },
        { tuple: ['label', evidence], labels: { 'known-a': evidence, other: evidence } },
        extractionOptions,
      ),
    ).toEqual([
      { evidence, dataPath: '/data/tuple/1' },
      { evidence, dataPath: '/data/labels/known-a' },
      { evidence, dataPath: '/data/labels/other' },
    ]);
  });

  it('traverses draft-7 additional tuple items and branches selected by boolean conditions', () => {
    const marked = z.toJSONSchema(EvidenceValueSchema);
    const tupleSchema = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        tuple: {
          type: 'array',
          items: [{ type: 'string' }],
          additionalItems: marked,
        },
      },
    };
    const conditionalSchema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        selected: { if: true, then: marked, else: unmarkedEvidenceSchema() },
        rejected: { if: false, then: unmarkedEvidenceSchema(), else: marked },
      },
    };

    expect(extractEvidenceOccurrences(tupleSchema, { tuple: ['label', evidence] }, extractionOptions)).toEqual([
      { evidence, dataPath: '/data/tuple/1' },
    ]);
    expect(
      extractEvidenceOccurrences(conditionalSchema, { selected: evidence, rejected: evidence }, extractionOptions),
    ).toEqual([
      { evidence, dataPath: '/data/selected' },
      { evidence, dataPath: '/data/rejected' },
    ]);
  });

  it('discovers evidence declared by a successful if schema', () => {
    const marked = z.toJSONSchema(EvidenceValueSchema);
    const schema = { type: 'object', properties: { payload: { if: marked, then: true, else: { type: 'string' } } } };

    expect(extractEvidenceOccurrences(schema, { payload: evidence }, extractionOptions)).toEqual([
      { evidence, dataPath: '/data/payload' },
    ]);
    expect(extractEvidenceOccurrences(schema, { payload: 'illustrative' }, extractionOptions)).toEqual([]);
  });

  it('respects boolean declared properties and resolves array segments in local references', () => {
    const marked = z.toJSONSchema(EvidenceValueSchema);
    const schema = {
      type: 'object',
      properties: { declared: true, payload: { $ref: '#/anyOf/0' } },
      additionalProperties: marked,
      anyOf: [{ type: 'object', properties: { evidence: marked } }],
    };

    expect(
      extractEvidenceOccurrences(
        schema,
        { declared: evidence, payload: { evidence }, extra: evidence },
        extractionOptions,
      ),
    ).toEqual([
      { evidence, dataPath: '/data/payload/evidence' },
      { evidence, dataPath: '/data/extra' },
    ]);
  });

  it('decodes URI fragments before resolving JSON Pointer tokens', () => {
    const marked = z.toJSONSchema(EvidenceValueSchema);
    const schema = {
      type: 'object',
      properties: { payload: { $ref: '#/$defs/a%25b' } },
      $defs: { 'a%b': marked },
    };

    expect(extractEvidenceOccurrences(schema, { payload: evidence }, extractionOptions)).toEqual([
      { evidence, dataPath: '/data/payload' },
    ]);
  });

  it('ignores draft-7 reference siblings and rejects marked unevaluated applicators', () => {
    const marked = z.toJSONSchema(EvidenceValueSchema);
    expect(
      extractEvidenceOccurrences(
        {
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'object',
          properties: { value: { $ref: '#/$defs/anything', ...marked } },
          $defs: { anything: true },
        },
        { value: evidence },
        extractionOptions,
      ),
    ).toEqual([]);
    expect(() =>
      extractEvidenceOccurrences(
        {
          type: 'object',
          unevaluatedProperties: { $ref: '#/$defs/container/properties/not' },
          $defs: { container: { properties: { not: marked } } },
        },
        { extra: evidence },
        extractionOptions,
      ),
    ).toThrow('Evidence under unsupported unevaluatedProperties applicator at /data');
    expect(
      extractEvidenceOccurrences(
        { type: 'object', unevaluatedProperties: { $defs: { unusedEvidence: marked }, type: 'string' } },
        { extra: 'allowed' },
        extractionOptions,
      ),
    ).toEqual([]);
  });

  it('fails visibly for active dynamic references but ignores unselected branches', () => {
    const dynamic = { $dynamicRef: '#evidence' };
    expect(() => extractEvidenceOccurrences(dynamic, evidence, extractionOptions)).toThrow(
      'Evidence discovery does not support active $dynamicRef at /data',
    );
    expect(
      extractEvidenceOccurrences(
        {
          type: 'object',
          properties: {
            payload: { oneOf: [{ type: 'string' }, { type: 'object', properties: { evidence: dynamic } }] },
          },
        },
        { payload: 'illustrative' },
        extractionOptions,
      ),
    ).toEqual([]);
    expect(() =>
      extractEvidenceOccurrences(
        { type: 'object', unevaluatedProperties: { properties: { evidence: dynamic } } },
        { evidence },
        extractionOptions,
      ),
    ).toThrow('Evidence under unsupported unevaluatedProperties applicator at /data');
  });

  it('fails only for active local references inside nested schema resources', () => {
    const marked = z.toJSONSchema(EvidenceValueSchema);
    const nestedReference = {
      $id: 'https://example.test/nested',
      type: 'object',
      properties: { evidence: { $ref: '#/$defs/evidence' } },
      $defs: { evidence: marked },
    };
    expect(() =>
      extractEvidenceOccurrences(
        { type: 'object', properties: { payload: nestedReference } },
        { payload: { evidence } },
        extractionOptions,
      ),
    ).toThrow('Evidence discovery does not support local $ref inside nested $id resource at /data/payload/evidence');
    expect(
      extractEvidenceOccurrences(
        {
          type: 'object',
          properties: {
            payload: { oneOf: [{ type: 'string' }, nestedReference] },
            direct: { $id: 'https://example.test/direct', ...marked },
          },
        },
        { payload: 'illustrative', direct: evidence },
        extractionOptions,
      ),
    ).toEqual([{ evidence, dataPath: '/data/direct' }]);
    expect(() =>
      extractEvidenceOccurrences(
        { type: 'object', unevaluatedProperties: nestedReference },
        { payload: { evidence } },
        extractionOptions,
      ),
    ).toThrow('Evidence under unsupported unevaluatedProperties applicator at /data');
  });

  it('preserves resource ancestry and unresolved references in unsupported-applicator probes', () => {
    const marked = z.toJSONSchema(EvidenceValueSchema);
    const nested = {
      $id: 'https://example.test/nested-probe',
      type: 'object',
      unevaluatedProperties: { $ref: '#/$defs/evidence' },
      $defs: { evidence: marked },
    };
    expect(() =>
      extractEvidenceOccurrences(
        { type: 'object', properties: { payload: nested } },
        { payload: { extra: evidence } },
        extractionOptions,
      ),
    ).toThrow('Evidence under unsupported unevaluatedProperties applicator at /data/payload');
    expect(() =>
      extractEvidenceOccurrences(
        {
          type: 'object',
          unevaluatedProperties: { $ref: '#/$defs/nested/properties/evidence' },
          $defs: { nested: { $id: 'https://example.test/nested-target', properties: { evidence: marked } } },
        },
        { extra: evidence },
        extractionOptions,
      ),
    ).toThrow('Evidence under unsupported unevaluatedProperties applicator at /data');
    expect(() =>
      extractEvidenceOccurrences(
        {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          unevaluatedProperties: { $ref: '#evidenceAnchor' },
          $defs: { evidence: { $anchor: 'evidenceAnchor', ...marked } },
        },
        { extra: evidence },
        extractionOptions,
      ),
    ).toThrow('Evidence under unsupported unevaluatedProperties applicator at /data');
    expect(
      extractEvidenceOccurrences(
        { $id: 'https://example.test/root', type: 'object', unevaluatedProperties: { $ref: '#' } },
        {},
        extractionOptions,
      ),
    ).toEqual([]);
  });
});
