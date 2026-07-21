import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ArtifactViewResolveRequestSchema,
  ArtifactViewResolveResponseSchema,
  MaterializationSchemas,
  MaterializationSubjects,
} from '../namespace.js';
import { ArtifactProjectionPolicySchema } from '../schemas.js';

describe('Materialization namespace', () => {
  it('defines a provider-neutral materialization ref changed event', () => {
    const schema = MaterializationSchemas['ref.changed'];

    expect(MaterializationSubjects.ref.changed.subject).toBe('ref.changed');
    expect(MaterializationSubjects.ref.changed.$meta.namespace).toBe('materialization');
    expect(schema).toBeDefined();
    expect(
      schema?.safeParse({
        artifactId: 'artifact-1',
        provider: 'github',
        externalId: 'I_kwDOExample',
        operation: 'upserted',
      }).success,
    ).toBe(true);
    expect(
      schema?.safeParse({
        artifactId: 'artifact-1',
        provider: 'github',
        externalId: 'I_kwDOExample',
        operation: 'deleted',
      }).success,
    ).toBe(true);
    expect(
      schema?.safeParse({
        artifactId: 'artifact-1',
        provider: 'github',
        externalId: 'I_kwDOExample',
        operation: 'removed',
      }).success,
    ).toBe(false);
  });

  it('accepts ref.changed with omitted origin (existing external emitters)', () => {
    const schema = MaterializationSchemas['ref.changed'];

    const result = schema.safeParse({
      artifactId: 'artifact-ext',
      provider: 'jira',
      externalId: 'JIRA-42',
      operation: 'upserted',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.origin).toBeUndefined();
    }
  });

  it('accepts ref.changed with origin factory', () => {
    const schema = MaterializationSchemas['ref.changed'];

    const result = schema.safeParse({
      artifactId: 'artifact-factory',
      provider: 'github',
      externalId: 'I_factory',
      operation: 'upserted',
      origin: 'factory',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.origin).toBe('factory');
    }
  });

  it('accepts ref.changed with origin external', () => {
    const schema = MaterializationSchemas['ref.changed'];

    const result = schema.safeParse({
      artifactId: 'artifact-ext-origin',
      provider: 'github',
      externalId: 'I_external',
      operation: 'deleted',
      origin: 'external',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.origin).toBe('external');
    }
  });

  it('rejects ref.changed with unknown origin value', () => {
    const schema = MaterializationSchemas['ref.changed'];

    const result = schema.safeParse({
      artifactId: 'artifact-bad',
      provider: 'github',
      externalId: 'I_bad',
      operation: 'upserted',
      origin: 'webhook',
    });

    expect(result.success).toBe(false);
  });

  it('defines a provider-neutral capability resolved event', () => {
    const schema = MaterializationSchemas['capability.resolved'];

    expect(MaterializationSubjects.capability.resolved.subject).toBe('capability.resolved');
    expect(MaterializationSubjects.capability.resolved.$meta.namespace).toBe('materialization');
    expect(schema).toBeDefined();
    expect(
      schema?.safeParse({
        provider: 'github',
        surface: 'issue',
        capabilities: {
          issueType: true,
          issueFields: false,
          subIssues: true,
        },
        degraded: true,
      }).success,
    ).toBe(true);
    expect(
      schema?.safeParse({
        provider: 'github',
        surface: 'issue',
        capabilities: {
          issueFields: 'available',
        },
        degraded: true,
      }).success,
    ).toBe(false);
  });
});

describe('surfaceBinding.list request schema', () => {
  it('accepts an id filter for exact binding lookup', () => {
    const schema = MaterializationSchemas['surfaceBinding.list'].request;
    const result = schema.safeParse({ id: 'github.status.field' });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ id: 'github.status.field' });
  });

  it('accepts id combined with provider and namespace', () => {
    const schema = MaterializationSchemas['surfaceBinding.list'].request;
    const result = schema.safeParse({
      id: 'github.status.field',
      provider: 'github',
      namespace: 'status',
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      id: 'github.status.field',
      provider: 'github',
      namespace: 'status',
    });
  });

  it('rejects empty string id', () => {
    const schema = MaterializationSchemas['surfaceBinding.list'].request;
    const result = schema.safeParse({ id: '' });

    expect(result.success).toBe(false);
  });
});

describe('ArtifactProjectionPolicySchema projectedFields', () => {
  it('parses provider-neutral projected field declarations', () => {
    const parsed = ArtifactProjectionPolicySchema.parse({
      mode: 'surface',
      projectedFields: [
        { path: 'status', semantic: 'status' },
        { path: 'priority', semantic: 'priority' },
        { path: 'title' },
      ],
    });

    expect(parsed.projectedFields).toEqual([
      { path: 'status', semantic: 'status' },
      { path: 'priority', semantic: 'priority' },
      { path: 'title' },
    ]);
  });

  it('rejects empty projected field paths', () => {
    expect(() =>
      ArtifactProjectionPolicySchema.parse({
        mode: 'surface',
        projectedFields: [{ path: '' }],
      }),
    ).toThrow();
  });
});

describe('artifact.view.resolve RPC protocol', () => {
  const ref = { refClass: 'artifact' as const, kind: 'test-kind', id: 'artifact-123', revision: 'rev-1' };
  it('has the fully qualified subject materialization.artifact.view.resolve', () => {
    expect(MaterializationSubjects.artifact.view.resolve.subject).toBe('artifact.view.resolve');
    expect(MaterializationSubjects.artifact.view.resolve.$meta.namespace).toBe('materialization');
  });

  it('parses an own-view resolve request', () => {
    const schema = MaterializationSchemas['artifact.view.resolve'];
    expect('request' in schema).toBe(true);
    const request = (schema as { request: z.ZodType }).request;

    const result = request.safeParse({
      ref,
      level: 'full',
      affordance: { kind: 'own-view' },
    });

    expect(result.success).toBe(true);
  });

  it('requires an immutable artifact ref for a resolve request', () => {
    expect(
      ArtifactViewResolveRequestSchema.safeParse({
        ref: 'artifact-123',
        level: 'full',
        affordance: { kind: 'own-view' },
      }).success,
    ).toBe(false);
    expect(
      ArtifactViewResolveRequestSchema.safeParse({
        ref: { refClass: 'artifact', kind: 'test-kind', id: 'artifact-123' },
        level: 'full',
        affordance: { kind: 'own-view' },
      }).success,
    ).toBe(false);
  });

  it('parses an inline resolve request with host relation', () => {
    const schema = MaterializationSchemas['artifact.view.resolve'];
    const request = (schema as { request: z.ZodType }).request;

    const result = request.safeParse({
      ref: { ...ref, id: 'artifact-456' },
      level: 'summary',
      affordance: { kind: 'inline', hostRelation: 'blocked-by' },
    });

    expect(result.success).toBe(true);
  });

  it('parses an entry resolve request with via (level on top-level only)', () => {
    const schema = MaterializationSchemas['artifact.view.resolve'];
    const request = (schema as { request: z.ZodType }).request;

    const result = request.safeParse({
      ref: { ...ref, id: 'artifact-789' },
      level: 'summary',
      affordance: { kind: 'entry', via: 'dashboard' },
    });

    expect(result.success).toBe(true);
  });

  it('parses an entry resolve request with collection (level on top-level only)', () => {
    const schema = MaterializationSchemas['artifact.view.resolve'];
    const request = (schema as { request: z.ZodType }).request;

    const result = request.safeParse({
      ref: { ...ref, id: 'artifact-789' },
      level: 'link',
      affordance: { kind: 'entry', collection: 'recent' },
    });

    expect(result.success).toBe(true);
  });

  it('strips level from entry affordance in resolve request (container uses top-level)', () => {
    const result = ArtifactViewResolveRequestSchema.safeParse({
      ref: { ...ref, id: 'artifact-789' },
      level: 'summary',
      affordance: { kind: 'entry', via: 'dashboard', level: 'link' },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      const { affordance } = result.data;
      expect('level' in affordance).toBe(false);
      expect(result.data.level).toBe('summary');
    }
  });

  it('accepts optional JSON-safe params', () => {
    const schema = MaterializationSchemas['artifact.view.resolve'];
    const request = (schema as { request: z.ZodType }).request;

    const result = request.safeParse({
      ref,
      level: 'full',
      affordance: { kind: 'own-view' },
      params: { depth: 3, includeArchived: true },
    });

    expect(result.success).toBe(true);
  });

  it('rejects non-JSON params (function value)', () => {
    const schema = MaterializationSchemas['artifact.view.resolve'];
    const request = (schema as { request: z.ZodType }).request;

    const result = request.safeParse({
      ref,
      level: 'full',
      affordance: { kind: 'own-view' },
      params: 'not-an-object',
    });

    expect(result.success).toBe(false);
  });

  it('parses a successful ok response with view, builder version, and source revision', () => {
    const schema = MaterializationSchemas['artifact.view.resolve'];
    const response = (schema as { response: z.ZodType }).response;

    const result = response.safeParse({
      status: 'ok',
      view: {
        title: 'Implementation Plan',
        artifact: { id: 'plan-1', kind: 'implementation-plan', revision: 'rev-1' },
        navigation: { breadcrumbs: [], related: [] },
        sections: [{ type: 'summary', title: 'Overview', text: 'A plan for implementing views.' }],
        links: {},
      },
      builderVersion: 1,
      sourceRevision: 'rev-1',
    });

    expect(result.success).toBe(true);
  });

  it('requires positive integer builder version on ok response', () => {
    const schema = MaterializationSchemas['artifact.view.resolve'];
    const response = (schema as { response: z.ZodType }).response;

    expect(
      response.safeParse({
        status: 'ok',
        view: {
          title: 'Test',
          artifact: { id: 'test-1', kind: 'test', revision: 'rev-1' },
          navigation: { breadcrumbs: [], related: [] },
          sections: [],
          links: {},
        },
        builderVersion: 0,
        sourceRevision: 'rev-1',
      }).success,
    ).toBe(false);

    expect(
      response.safeParse({
        status: 'ok',
        view: {
          title: 'Test',
          artifact: { id: 'test-1', kind: 'test', revision: 'rev-1' },
          navigation: { breadcrumbs: [], related: [] },
          sections: [],
          links: {},
        },
        builderVersion: 1.5,
        sourceRevision: 'rev-1',
      }).success,
    ).toBe(false);
  });

  it('requires the exact source revision on an ok response', () => {
    const schema = MaterializationSchemas['artifact.view.resolve'];
    const response = (schema as { response: z.ZodType }).response;

    expect(
      response.safeParse({
        status: 'ok',
        view: {
          title: 'Test',
          artifact: { id: 'test-1', kind: 'test', revision: 'rev-1' },
          navigation: { breadcrumbs: [], related: [] },
          sections: [],
          links: {},
        },
        builderVersion: 1,
      }).success,
    ).toBe(false);
  });

  it('parses an artifact-not-found response', () => {
    const schema = MaterializationSchemas['artifact.view.resolve'];
    const response = (schema as { response: z.ZodType }).response;

    const result = response.safeParse({
      status: 'artifact-not-found',
      view: null,
    });

    expect(result.success).toBe(true);
  });

  it('parses a not-rendered response', () => {
    const schema = MaterializationSchemas['artifact.view.resolve'];
    const response = (schema as { response: z.ZodType }).response;

    const result = response.safeParse({
      status: 'not-rendered',
      view: null,
    });

    expect(result.success).toBe(true);
  });

  it('rejects unknown status value', () => {
    const schema = MaterializationSchemas['artifact.view.resolve'];
    const response = (schema as { response: z.ZodType }).response;

    const result = response.safeParse({
      status: 'error',
      view: null,
    });

    expect(result.success).toBe(false);
  });

  it('error variants do not require ref, level, or affordance fields', () => {
    const schema = MaterializationSchemas['artifact.view.resolve'];
    const response = (schema as { response: z.ZodType }).response;

    // artifact-not-found needs only status and view: null
    const notFound = response.safeParse({
      status: 'artifact-not-found',
      view: null,
    });
    expect(notFound.success).toBe(true);

    // not-rendered needs only status and view: null
    const notRendered = response.safeParse({
      status: 'not-rendered',
      view: null,
    });
    expect(notRendered.success).toBe(true);
  });

  it('strips unknown builder functions from the namespace payload', () => {
    const schema = MaterializationSchemas['artifact.view.resolve'];
    const response = (schema as { response: z.ZodType }).response;

    const result = response.safeParse({
      status: 'ok',
      view: {
        title: 'Test',
        artifact: { id: 'test-1', kind: 'test', revision: 'rev-1' },
        navigation: { breadcrumbs: [], related: [] },
        sections: [],
        links: {},
      },
      builderVersion: 1,
      sourceRevision: 'rev-1',
      builder: () => ({}),
    });

    expect(result.success).toBe(true);
    if (!result.success) throw result.error;
    expect(result.data).not.toHaveProperty('builder');
  });

  it('all section variants survive request/response round-trip parsing', () => {
    const response = ArtifactViewResolveResponseSchema;

    const view = {
      title: 'Section Variants Test',
      artifact: { id: 'test-1', kind: 'test', revision: 'rev-42' },
      navigation: { breadcrumbs: [], related: [] },
      sections: [
        { type: 'summary', title: 'Summary', text: 'A summary section.' },
        {
          type: 'properties',
          title: 'Props',
          rows: [{ label: 'Status', value: 'active' }],
        },
        {
          type: 'table',
          title: 'Table',
          columns: ['A'],
          rows: [{ cells: ['val'] }],
        },
        {
          type: 'relations',
          title: 'Rels',
          groups: [{ type: 'depends-on', items: [{ label: 'dep-1' }] }],
        },
        {
          type: 'evidence',
          title: 'Evidence',
          items: [{ kind: 'commit', id: 'abc123' }],
        },
        {
          type: 'raw',
          title: 'Raw',
          json: { key: 'value' },
        },
        {
          type: 'code',
          title: 'Code',
          language: 'typescript',
          content: 'const x = 1;',
        },
        {
          type: 'diagram',
          title: 'Diagram',
          notation: 'mermaid',
          source: 'graph TD; A-->B',
        },
      ],
      links: {},
    };

    const result = response.safeParse({
      status: 'ok',
      view,
      builderVersion: 42,
      sourceRevision: 'rev-42',
    });

    expect(result.success).toBe(true);
    if (result.success && result.data.status === 'ok') {
      expect(result.data.status).toBe('ok');
      expect(result.data.view.sections).toHaveLength(8);
      expect(result.data.builderVersion).toBe(42);
      expect(result.data.sourceRevision).toBe('rev-42');
    }
  });
});

describe('artifact.view.resolve public exports', () => {
  it('exports resolve request and response types from the materialization barrel', async () => {
    const mod = await import('../index.js');

    expect(mod.ArtifactViewResolveRequestSchema).toBeDefined();
    expect(mod.ArtifactViewResolveResponseSchema).toBeDefined();
  });

  it('exports resolve types from the root contracts barrel', async () => {
    const mod = await import('@makaio/contracts');

    expect(mod.ArtifactViewResolveRequestSchema).toBeDefined();
    expect(mod.ArtifactViewResolveResponseSchema).toBeDefined();
  });
});
