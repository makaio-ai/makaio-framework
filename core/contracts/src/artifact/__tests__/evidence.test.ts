import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { defineArtifactKind } from '../kind-definition.js';
import { EvidenceValueSchema } from '../evidence.js';
import { ArtifactSchemas } from '../namespace.js';
import {
  ArtifactRefSchema,
  ArtifactRelationQueryTargetSchema,
  ArtifactRelationTargetSchema,
  EvidenceRefSchema,
  LocalRefSchema,
} from '../schemas.js';

const SHA_1 = '0123456789abcdef0123456789abcdef01234567';
const SHA_256 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const artifactRef = {
  refClass: 'artifact' as const,
  kind: 'implementation-plan',
  id: 'plan-1',
  revision: 'revision-3',
};

const acceptedEvidence = [
  {
    label: 'whole Git file pinned to SHA-1',
    value: {
      source: {
        kind: 'git-file',
        repository: { kind: 'github-cloud', path: 'makaio-ai/makaio' },
        path: 'src/index.ts',
        commit: SHA_1,
      },
      location: { kind: 'whole-source' },
    },
  },
  {
    label: 'Git line range pinned to SHA-256',
    value: {
      source: {
        kind: 'git-file',
        repository: { kind: 'github-cloud', path: 'makaio-ai/makaio' },
        path: 'src/index.ts',
        commit: SHA_256,
      },
      location: { kind: 'lines', startLine: 12, lineCount: 4 },
      excerpt: 'export const value = 1;',
    },
  },
  {
    label: 'versioned Confluence page',
    value: {
      source: { kind: 'confluence-page', site: 'example.atlassian.net', pageId: '10715138', version: 7 },
      location: { kind: 'whole-source' },
    },
  },
  {
    label: 'whole artifact revision',
    value: {
      source: { kind: 'artifact', reference: artifactRef },
      location: { kind: 'whole-source' },
    },
  },
  {
    label: 'artifact data path',
    value: {
      source: { kind: 'artifact', reference: artifactRef },
      location: { kind: 'data-path', path: 'findings.primary-summary' },
    },
  },
] as const;

const rejectedEvidence = [
  {
    label: 'legacy Git repository string',
    value: {
      source: { kind: 'git-file', repository: 'makaio-ai/makaio', path: 'src/index.ts', commit: SHA_1 },
      location: { kind: 'whole-source' },
    },
  },
  {
    label: 'branch name instead of a concrete commit',
    value: {
      source: {
        kind: 'git-file',
        repository: { kind: 'github-cloud', path: 'makaio-ai/makaio' },
        path: 'src/index.ts',
        commit: 'main',
      },
      location: { kind: 'whole-source' },
    },
  },
  {
    label: 'abbreviated commit',
    value: {
      source: {
        kind: 'git-file',
        repository: { kind: 'github-cloud', path: 'makaio-ai/makaio' },
        path: 'src/index.ts',
        commit: '0123456',
      },
      location: { kind: 'whole-source' },
    },
  },
  {
    label: 'Git file without a commit',
    value: {
      source: {
        kind: 'git-file',
        repository: { kind: 'github-cloud', path: 'makaio-ai/makaio' },
        path: 'src/index.ts',
      },
      location: { kind: 'whole-source' },
    },
  },
  {
    label: 'Git file with a whitespace-only repository',
    value: {
      source: {
        kind: 'git-file',
        repository: { kind: 'github-cloud', path: '   ' },
        path: 'src/index.ts',
        commit: SHA_1,
      },
      location: { kind: 'whole-source' },
    },
  },
  {
    label: 'Confluence page without a version',
    value: {
      source: { kind: 'confluence-page', site: 'example.atlassian.net', pageId: '10715138' },
      location: { kind: 'whole-source' },
    },
  },
  {
    label: 'artifact without a revision',
    value: {
      source: {
        kind: 'artifact',
        reference: { refClass: 'artifact', kind: 'implementation-plan', id: 'plan-1' },
      },
      location: { kind: 'whole-source' },
    },
  },
  {
    label: 'artifact reference without an explicit refClass',
    value: {
      source: {
        kind: 'artifact',
        reference: { kind: 'implementation-plan', id: 'plan-1', revision: 'revision-3' },
      },
      location: { kind: 'whole-source' },
    },
  },
  {
    label: 'data path on a Git file',
    value: {
      source: {
        kind: 'git-file',
        repository: { kind: 'github-cloud', path: 'makaio-ai/makaio' },
        path: 'src/index.ts',
        commit: SHA_1,
      },
      location: { kind: 'data-path', path: 'findings.summary' },
    },
  },
  {
    label: 'line range on a Confluence page',
    value: {
      source: { kind: 'confluence-page', site: 'example.atlassian.net', pageId: '10715138', version: 7 },
      location: { kind: 'lines', startLine: 1, lineCount: 2 },
    },
  },
  {
    label: 'line range on an artifact',
    value: {
      source: { kind: 'artifact', reference: artifactRef },
      location: { kind: 'lines', startLine: 1, lineCount: 2 },
    },
  },
  {
    label: 'unknown top-level field',
    value: {
      source: {
        kind: 'git-file',
        repository: { kind: 'github-cloud', path: 'makaio-ai/makaio' },
        path: 'src/index.ts',
        commit: SHA_1,
      },
      location: { kind: 'whole-source' },
      note: 'undeclared',
    },
  },
  {
    label: 'unknown source field',
    value: {
      source: {
        kind: 'confluence-page',
        site: 'example.atlassian.net',
        pageId: '10715138',
        version: 7,
        url: 'https://example.atlassian.net/wiki/10715138',
      },
      location: { kind: 'whole-source' },
    },
  },
  {
    label: 'unknown nested repository field',
    value: {
      source: {
        kind: 'git-file',
        repository: { kind: 'github-cloud', path: 'makaio-ai/makaio', host: 'github.com' },
        path: 'src/index.ts',
        commit: SHA_1,
      },
      location: { kind: 'whole-source' },
    },
  },
  {
    label: 'unknown location field',
    value: {
      source: { kind: 'artifact', reference: artifactRef },
      location: { kind: 'whole-source', path: 'findings.summary' },
    },
  },
  {
    label: 'JSON Pointer artifact path',
    value: {
      source: { kind: 'artifact', reference: artifactRef },
      location: { kind: 'data-path', path: '/findings/summary' },
    },
  },
  {
    label: 'artifact path with an array index',
    value: {
      source: { kind: 'artifact', reference: artifactRef },
      location: { kind: 'data-path', path: 'findings.0.summary' },
    },
  },
] as const;

const validateEvidenceJsonSchema = new Ajv2020({ strict: false }).compile(z.toJSONSchema(EvidenceValueSchema));

describe('EvidenceValueSchema', () => {
  it.each(acceptedEvidence)('accepts $label', ({ value }) => {
    expect(EvidenceValueSchema.parse(value)).toEqual(value);
  });

  it.each(rejectedEvidence)('rejects $label', ({ value }) => {
    expect(EvidenceValueSchema.safeParse(value).success).toBe(false);
  });

  it('canonicalizes repository identity while preserving file paths and rejecting whitespace-only identities', () => {
    const value = {
      source: {
        kind: 'git-file',
        repository: { kind: ' github-cloud ', path: ' makaio-ai/makaio ' },
        path: ' src/index.ts ',
        commit: SHA_1,
      },
      location: { kind: 'whole-source' },
    };
    expect(EvidenceValueSchema.parse(value)).toEqual({
      ...value,
      source: {
        ...value.source,
        repository: { kind: 'github-cloud', path: 'makaio-ai/makaio' },
      },
    });

    for (const source of [
      { ...value.source, repository: { ...value.source.repository, path: '   ' } },
      { ...value.source, path: '\t' },
    ]) {
      expect(EvidenceValueSchema.safeParse({ ...value, source }).success).toBe(false);
    }
  });

  it('keeps relation EvidenceRef values distinct from immutable direct evidence', () => {
    const relationRef = {
      kind: 'source-file',
      id: 'src/index.ts',
      revision: SHA_1,
      locator: 'L12-L15',
    };
    expect(EvidenceRefSchema.parse(relationRef)).toEqual({ refClass: 'evidence', ...relationRef });
    expect(ArtifactRelationTargetSchema.parse(relationRef)).toEqual({ refClass: 'evidence', ...relationRef });
    expect(EvidenceValueSchema.safeParse(relationRef).success).toBe(false);
  });

  it('preserves source and location pairings in evidence resolution responses', () => {
    const responseSchema = ArtifactSchemas['evidence.resolve'].response;
    const content = { kind: 'text' as const, text: 'resolved' };
    expect(
      responseSchema.safeParse({
        source: acceptedEvidence[0].value.source,
        location: { kind: 'lines', startLine: 1, lineCount: 1 },
        content,
      }).success,
    ).toBe(true);
    expect(
      responseSchema.safeParse({
        source: acceptedEvidence[2].value.source,
        location: { kind: 'lines', startLine: 1, lineCount: 1 },
        content,
      }).success,
    ).toBe(false);
  });

  it('preserves evidence omission and explicit empty lists across writes and lifecycle events', () => {
    const revision = {
      kind: 'review-result',
      schemaVersion: 1,
      scope: { level: 'global' },
      data: { title: 'Review result' },
      relations: [],
      actor: { kind: 'agent', id: 'reviewer' },
    };
    const artifact = {
      ...revision,
      id: 'review-1',
      revision: 'revision-1',
      timestamp: 1700000000000,
    };
    const previous = { refClass: 'artifact' as const, kind: artifact.kind, id: artifact.id, revision: 'revision-0' };

    const omitted = [
      ArtifactSchemas.create.request.parse(revision),
      ArtifactSchemas.revise.request.parse({ previous, revision }).revision,
      ArtifactSchemas.created.parse({ artifact }).artifact,
      ArtifactSchemas.revised.parse({ previous, artifact }).artifact,
    ];
    for (const parsed of omitted) expect(parsed).not.toHaveProperty('evidence');

    const explicit = [
      ArtifactSchemas.create.request.parse({ ...revision, evidence: [] }),
      ArtifactSchemas.revise.request.parse({ previous, revision: { ...revision, evidence: [] } }).revision,
      ArtifactSchemas.created.parse({ artifact: { ...artifact, evidence: [] } }).artifact,
      ArtifactSchemas.revised.parse({ previous, artifact: { ...artifact, evidence: [] } }).artifact,
    ];
    for (const parsed of explicit) expect(parsed.evidence).toEqual([]);
  });

  it('enforces nonempty evidence values across writes and lifecycle events', () => {
    const revision = {
      kind: 'review-result',
      schemaVersion: 1,
      scope: { level: 'global' },
      data: { title: 'Review result' },
      relations: [],
      actor: { kind: 'agent', id: 'reviewer' },
    };
    const artifact = {
      ...revision,
      id: 'review-1',
      revision: 'revision-1',
      timestamp: 1700000000000,
    };
    const previous = { refClass: 'artifact' as const, kind: artifact.kind, id: artifact.id, revision: 'revision-0' };
    const evidence = [acceptedEvidence[0].value];
    const unpinnedEvidence = [rejectedEvidence[0].value];

    const parsed = [
      ArtifactSchemas.create.request.parse({ ...revision, evidence }).evidence,
      ArtifactSchemas.revise.request.parse({ previous, revision: { ...revision, evidence } }).revision.evidence,
      ArtifactSchemas.created.parse({ artifact: { ...artifact, evidence } }).artifact.evidence,
      ArtifactSchemas.revised.parse({ previous, artifact: { ...artifact, evidence } }).artifact.evidence,
    ];
    for (const value of parsed) expect(value).toEqual(evidence);

    const rejected = [
      ArtifactSchemas.create.request.safeParse({ ...revision, evidence: unpinnedEvidence }).success,
      ArtifactSchemas.revise.request.safeParse({ previous, revision: { ...revision, evidence: unpinnedEvidence } })
        .success,
      ArtifactSchemas.created.safeParse({ artifact: { ...artifact, evidence: unpinnedEvidence } }).success,
      ArtifactSchemas.revised.safeParse({ previous, artifact: { ...artifact, evidence: unpinnedEvidence } }).success,
    ];
    expect(rejected).toEqual([false, false, false, false]);
  });

  it('retains EvidenceValue metadata in a serialized artifact-kind registration', () => {
    const registration = defineArtifactKind({
      kind: 'evidence-record',
      description: 'Record containing one direct evidence citation.',
      schemaVersion: 1,
      category: 'record',
      titlePath: 'title',
      dataSchema: z.strictObject({ title: z.string(), evidence: EvidenceValueSchema }),
    }).toRegistration();

    expect(registration.dataSchema).toMatchObject({
      properties: { evidence: { title: 'EvidenceValue', 'x-makaio-value-type': 'evidence/v1' } },
    });
  });

  it.each([...acceptedEvidence, ...rejectedEvidence])('matches its generated JSON Schema for $label', ({ value }) => {
    expect(validateEvidenceJsonSchema(value)).toBe(EvidenceValueSchema.safeParse(value).success);
  });
});

describe('ArtifactRefSchema strictness', () => {
  it('preserves nonblank coordinates byte-for-byte', () => {
    const value = {
      refClass: 'artifact' as const,
      kind: ' implementation-plan ',
      id: ' plan-1 ',
      revision: ' revision-3 ',
    };
    expect(ArtifactRefSchema.parse(value)).toEqual(value);
  });

  it('rejects blank coordinates and unknown fields directly and through nested reference schemas', () => {
    for (const value of [
      { ...artifactRef, kind: ' ' },
      { ...artifactRef, id: '\t' },
      { ...artifactRef, revision: '\n' },
      { ...artifactRef, mutable: true },
      { kind: artifactRef.kind, id: artifactRef.id, revision: artifactRef.revision },
    ]) {
      expect(ArtifactRefSchema.safeParse(value).success).toBe(false);
    }

    expect(
      LocalRefSchema.safeParse({ artifact: { ...artifactRef, mutable: true }, localId: 'finding-1' }).success,
    ).toBe(false);
    expect(
      ArtifactRelationQueryTargetSchema.safeParse({
        refClass: 'artifact',
        kind: artifactRef.kind,
        id: artifactRef.id,
        mutable: true,
      }).success,
    ).toBe(false);
  });

  it('allows an omitted query revision but rejects a whitespace-only provided revision', () => {
    const queryTarget = { refClass: 'artifact' as const, kind: artifactRef.kind, id: artifactRef.id };
    expect(ArtifactRelationQueryTargetSchema.parse(queryTarget)).toEqual(queryTarget);
    expect(ArtifactRelationQueryTargetSchema.safeParse({ ...queryTarget, revision: ' ' }).success).toBe(false);
  });

  it('matches its generated JSON Schema for preserved, blank, and undeclared coordinates', () => {
    const validate = new Ajv2020({ strict: false }).compile(z.toJSONSchema(ArtifactRefSchema));
    for (const value of [
      artifactRef,
      { ...artifactRef, kind: ' implementation-plan ' },
      { ...artifactRef, kind: ' ' },
      { ...artifactRef, id: '\t' },
      { ...artifactRef, revision: '\n' },
      { ...artifactRef, mutable: true },
      { kind: artifactRef.kind, id: artifactRef.id, revision: artifactRef.revision },
    ]) {
      expect(validate(value)).toBe(ArtifactRefSchema.safeParse(value).success);
    }
  });
});
