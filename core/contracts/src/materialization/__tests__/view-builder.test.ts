import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  ArtifactViewParamsSchema,
  ArtifactViewRequestSchema,
  ArtifactViewAffordanceDeclarationSchema,
  ArtifactViewAffordanceRequestSchema,
  ArtifactProjectionPolicySchema,
  ProjectedFieldSchema,
} from '../index.js';
import {
  defineArtifactViewBuilder,
  type ArtifactViewBuilder,
  type ArtifactViewParamsFor,
  type MakaioExtension,
} from '@makaio/contracts';
import { parsed, rejected } from './helpers.js';

interface GitHubIssueViewParams {
  owner: string;
  repository: string;
  issueNumber: number;
}

declare module '@makaio/contracts' {
  interface ArtifactViewParamsMap {
    'github-issue': GitHubIssueViewParams;
    'jira-ticket': { projectKey: string; issueKey: string };
    'invalid-scalar': string;
    'invalid-array': readonly string[];
    'invalid-function': () => void;
  }
}

/* -------------------------------------------------------------------------- */
/*  ArtifactViewParamsSchema (runtime JSON safety)                            */
/* -------------------------------------------------------------------------- */

describe('ArtifactViewParamsSchema', () => {
  it('accepts a plain JSON object', () => {
    const params = parsed(ArtifactViewParamsSchema, { depth: 2, includeArchived: true });
    expect(params).toEqual({ depth: 2, includeArchived: true });
  });

  it('accepts an empty object', () => {
    const params = parsed(ArtifactViewParamsSchema, {});
    expect(params).toEqual({});
  });

  it('accepts nested JSON-safe values', () => {
    parsed(ArtifactViewParamsSchema, {
      filter: { status: ['active', 'pending'] },
      limit: 50,
    });
  });

  it('rejects functions', () => {
    rejected(ArtifactViewParamsSchema, { fn: () => 42 });
  });

  it('rejects symbols', () => {
    rejected(ArtifactViewParamsSchema, { sym: Symbol('bad') });
  });

  it('rejects undefined object values', () => {
    // z.record(z.string(), JsonValueSchema) rejects undefined values
    // because JsonValueSchema only accepts string|number|boolean|null|array|object
    rejected(ArtifactViewParamsSchema, { undef: undefined });
  });
});

/* -------------------------------------------------------------------------- */
/*  ArtifactViewParamsFor — kind-correlated authoring (type-level tests)      */
/* -------------------------------------------------------------------------- */

describe('ArtifactViewParamsFor — declaration merging', () => {
  it('preserves a contribution builder kind while its registry contract remains erased', () => {
    const extension: MakaioExtension = {
      name: 'github-views',
      displayName: 'GitHub Views',
      version: '0.1.0',
      artifactViewBuilders: {
        createBuilders: () => [
          defineArtifactViewBuilder({
            kind: 'github-issue',
            schemaVersion: '1',
            version: 1,
            async build(context) {
              expectTypeOf(context.params).toEqualTypeOf<GitHubIssueViewParams | undefined>();
              expectTypeOf(context.params?.owner).toEqualTypeOf<string | undefined>();
              // @ts-expect-error GitHub issue builders cannot read Jira params.
              expectTypeOf(context.params?.projectKey);
              return undefined;
            },
          }),
        ],
      },
    };

    expect(extension.artifactViewBuilders).toBeDefined();
  });

  it('correlates each builder kind with only that kind’s params', () => {
    const githubBuilder: ArtifactViewBuilder<'github-issue'> = {
      kind: 'github-issue',
      schemaVersion: '1',
      version: 1,
      async build(context) {
        expectTypeOf(context.params).toEqualTypeOf<GitHubIssueViewParams | undefined>();
        expectTypeOf(context.params?.owner).toEqualTypeOf<string | undefined>();
        // @ts-expect-error GitHub issue builders cannot read Jira params.
        expectTypeOf(context.params?.projectKey);
        return undefined;
      },
    };
    const jiraBuilder: ArtifactViewBuilder<'jira-ticket'> = {
      kind: 'jira-ticket',
      schemaVersion: '1',
      version: 1,
      async build(context) {
        expectTypeOf(context.params).toEqualTypeOf<{ projectKey: string; issueKey: string } | undefined>();
        expectTypeOf(context.params?.projectKey).toEqualTypeOf<string | undefined>();
        // @ts-expect-error Jira builders cannot read GitHub issue params.
        expectTypeOf(context.params?.owner);
        return undefined;
      },
    };

    expect(githubBuilder.kind).toBe('github-issue');
    expect(jiraBuilder.kind).toBe('jira-ticket');
  });

  it('keeps unregistered kinds open', () => {
    expectTypeOf<ArtifactViewParamsFor<'unregistered-kind'>>().toEqualTypeOf<Readonly<Record<string, unknown>>>();

    const unknownBuilder: ArtifactViewBuilder<'unregistered-kind'> = {
      kind: 'unregistered-kind',
      schemaVersion: '1',
      version: 1,
      async build(context) {
        expectTypeOf(context.params).toEqualTypeOf<Readonly<Record<string, unknown>> | undefined>();
        const opaqueValue = context.params?.anything;
        expectTypeOf(opaqueValue).toEqualTypeOf<unknown>();
        return undefined;
      },
    };

    expect(unknownBuilder.kind).toBe('unregistered-kind');
  });

  it('rejects scalar, array, and function registered params', () => {
    expectTypeOf<ArtifactViewParamsFor<'invalid-scalar'>>().toEqualTypeOf<never>();
    expectTypeOf<ArtifactViewParamsFor<'invalid-array'>>().toEqualTypeOf<never>();
    expectTypeOf<ArtifactViewParamsFor<'invalid-function'>>().toEqualTypeOf<never>();
  });
});

/* -------------------------------------------------------------------------- */
/*  ArtifactViewRequestSchema                                                 */
/* -------------------------------------------------------------------------- */

describe('ArtifactViewRequestSchema', () => {
  it('accepts a minimal request with level only', () => {
    const req = parsed(ArtifactViewRequestSchema, { level: 'summary' });
    expect(req.level).toBe('summary');
  });

  it('accepts a request with params', () => {
    const req = parsed(ArtifactViewRequestSchema, {
      level: 'full',
      params: { depth: 3 },
    });
    expect(req.params).toEqual({ depth: 3 });
  });

  it('rejects non-JSON params in request', () => {
    rejected(ArtifactViewRequestSchema, {
      level: 'full',
      params: { fn: () => {} },
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  ProjectedFieldSchema — extended with fromLevel and viewRole               */
/* -------------------------------------------------------------------------- */

describe('ProjectedFieldSchema — view extensions', () => {
  it('still accepts the original shape (backward compatible)', () => {
    const field = parsed(ProjectedFieldSchema, { path: 'status', semantic: 'status' });
    expect(field.path).toBe('status');
    expect(field.semantic).toBe('status');
  });

  it('accepts fromLevel', () => {
    const field = parsed(ProjectedFieldSchema, { path: 'title', fromLevel: 'link' });
    expect(field.fromLevel).toBe('link');
  });

  it('accepts viewRole: title', () => {
    const field = parsed(ProjectedFieldSchema, { path: 'name', viewRole: 'title' });
    expect(field.viewRole).toBe('title');
  });

  it('accepts viewRole: summary', () => {
    const field = parsed(ProjectedFieldSchema, { path: 'description', viewRole: 'summary' });
    expect(field.viewRole).toBe('summary');
  });

  it('rejects invalid fromLevel', () => {
    rejected(ProjectedFieldSchema, { path: 'x', fromLevel: 'detailed' });
  });

  it('rejects invalid viewRole', () => {
    rejected(ProjectedFieldSchema, { path: 'x', viewRole: 'heading' });
  });

  it('omitted fromLevel means full (default semantics, not schema default)', () => {
    const field = parsed(ProjectedFieldSchema, { path: 'status' });
    expect(field.fromLevel).toBeUndefined();
    // Consumers treat undefined as 'full' — this is a contract convention, not a schema default
  });
});

/* -------------------------------------------------------------------------- */
/*  ArtifactProjectionPolicySchema — viewRole refinements                     */
/* -------------------------------------------------------------------------- */

describe('ArtifactProjectionPolicySchema — viewRole constraints', () => {
  it('rejects more than one title field', () => {
    rejected(ArtifactProjectionPolicySchema, {
      mode: 'surface',
      projectedFields: [
        { path: 'name', viewRole: 'title' },
        { path: 'displayName', viewRole: 'title' },
      ],
    });
  });

  it('rejects more than one summary field', () => {
    rejected(ArtifactProjectionPolicySchema, {
      mode: 'surface',
      projectedFields: [
        { path: 'description', viewRole: 'summary' },
        { path: 'overview', viewRole: 'summary' },
      ],
    });
  });

  it('accepts at most one title and one summary', () => {
    const policy = parsed(ArtifactProjectionPolicySchema, {
      mode: 'surface',
      projectedFields: [
        { path: 'name', viewRole: 'title' },
        { path: 'description', viewRole: 'summary' },
        { path: 'status', semantic: 'status' },
      ],
    });
    expect(policy.projectedFields).toHaveLength(3);
  });

  it('monotone field thresholds: link fields are available at summary and full', () => {
    // A field with fromLevel: 'link' is the broadest — available everywhere
    const policy = parsed(ArtifactProjectionPolicySchema, {
      mode: 'surface',
      projectedFields: [
        { path: 'name', viewRole: 'title', fromLevel: 'link' },
        { path: 'status', fromLevel: 'summary' },
        { path: 'description', viewRole: 'summary', fromLevel: 'full' },
      ],
    });
    expect(policy.projectedFields).toHaveLength(3);
  });
});

/* -------------------------------------------------------------------------- */
/*  ArtifactViewAffordanceDeclarationSchema                                   */
/* -------------------------------------------------------------------------- */

describe('ArtifactViewAffordanceDeclarationSchema', () => {
  it('accepts own-view at full', () => {
    const decl = parsed(ArtifactViewAffordanceDeclarationSchema, {
      kind: 'own-view',
    });
    expect(decl.kind).toBe('own-view');
  });

  it('accepts inline with hostRelation and optional as', () => {
    const result = ArtifactViewAffordanceDeclarationSchema.safeParse({
      kind: 'inline',
      hostRelation: 'depends-on',
      as: 'summary',
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.kind === 'inline') {
      expect(result.data.hostRelation).toBe('depends-on');
      expect(result.data.as).toBe('summary');
    }
  });

  it('inline omitted as resolves as full (convention, not default)', () => {
    const result = ArtifactViewAffordanceDeclarationSchema.safeParse({
      kind: 'inline',
      hostRelation: 'evidence',
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.kind === 'inline') {
      expect(result.data.as).toBeUndefined();
    }
  });

  it('accepts entry with via', () => {
    const result = ArtifactViewAffordanceDeclarationSchema.safeParse({
      kind: 'entry',
      via: 'workstream-dashboard',
      title: 'Plans',
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.kind === 'entry') {
      expect(result.data.via).toBe('workstream-dashboard');
      expect(result.data.title).toBe('Plans');
    }
  });

  it('accepts entry with collection', () => {
    const result = ArtifactViewAffordanceDeclarationSchema.safeParse({
      kind: 'entry',
      collection: 'recent-artifacts',
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.kind === 'entry') {
      expect(result.data.collection).toBe('recent-artifacts');
    }
  });

  it('rejects entry with both via and collection', () => {
    rejected(ArtifactViewAffordanceDeclarationSchema, {
      kind: 'entry',
      via: 'dashboard',
      collection: 'recent',
    });
  });

  it('rejects entry with neither via nor collection', () => {
    rejected(ArtifactViewAffordanceDeclarationSchema, {
      kind: 'entry',
    });
  });

  it('accepts entry with hostRelation (declaration policy)', () => {
    const result = ArtifactViewAffordanceDeclarationSchema.safeParse({
      kind: 'entry',
      via: 'workstream-dashboard',
      hostRelation: 'belongs-to',
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.kind === 'entry') {
      expect(result.data.hostRelation).toBe('belongs-to');
      expect(result.data.via).toBe('workstream-dashboard');
    }
  });

  it('hostRelation without via or collection still fails the exactly-one-target refine', () => {
    rejected(ArtifactViewAffordanceDeclarationSchema, {
      kind: 'entry',
      hostRelation: 'belongs-to',
    });
  });

  it('multiple entry declarations are legal', () => {
    // An artifact kind may declare multiple entry affordances
    const entries = [
      { kind: 'entry', via: 'dashboard-a' },
      { kind: 'entry', collection: 'recent' },
      { kind: 'entry', via: 'dashboard-b', title: 'Alt View' },
    ];
    for (const entry of entries) {
      expect(ArtifactViewAffordanceDeclarationSchema.safeParse(entry).success).toBe(true);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  ArtifactViewAffordanceRequestSchema                                       */
/* -------------------------------------------------------------------------- */

describe('ArtifactViewAffordanceRequestSchema', () => {
  it('accepts own-view request', () => {
    const req = parsed(ArtifactViewAffordanceRequestSchema, {
      kind: 'own-view',
    });
    expect(req.kind).toBe('own-view');
  });

  it('accepts inline request with hostRelation', () => {
    const result = ArtifactViewAffordanceRequestSchema.safeParse({
      kind: 'inline',
      hostRelation: 'depends-on',
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.kind === 'inline') {
      expect(result.data.hostRelation).toBe('depends-on');
    }
  });

  it('inline request does NOT carry as (declaration-only)', () => {
    // The 'as' field is declaration policy, not caller-controlled
    const result = ArtifactViewAffordanceRequestSchema.safeParse({
      kind: 'inline',
      hostRelation: 'depends-on',
      as: 'summary',
    });
    // Should either strip the field or reject it
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).as).toBeUndefined();
    }
  });

  it('accepts entry request with via', () => {
    const result = ArtifactViewAffordanceRequestSchema.safeParse({
      kind: 'entry',
      via: 'dashboard',
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.kind === 'entry') {
      expect(result.data.via).toBe('dashboard');
    }
  });

  it('accepts entry request with collection', () => {
    const result = ArtifactViewAffordanceRequestSchema.safeParse({
      kind: 'entry',
      collection: 'recent',
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.kind === 'entry') {
      expect(result.data.collection).toBe('recent');
    }
  });

  it('entry request does NOT carry title (declaration-only)', () => {
    const result = ArtifactViewAffordanceRequestSchema.safeParse({
      kind: 'entry',
      via: 'dashboard',
      title: 'Should Not Appear',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).title).toBeUndefined();
    }
  });

  it('entry request does NOT carry hostRelation (declaration-only)', () => {
    const result = ArtifactViewAffordanceRequestSchema.safeParse({
      kind: 'entry',
      via: 'dashboard',
      hostRelation: 'belongs-to',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).hostRelation).toBeUndefined();
    }
  });

  it('entry request does NOT carry level (container selects via resolve request)', () => {
    const result = ArtifactViewAffordanceRequestSchema.safeParse({
      kind: 'entry',
      via: 'dashboard',
      level: 'link',
    });
    // The schema strips unknown keys — level should not appear on the parsed output
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).level).toBeUndefined();
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Affordance default behavior                                               */
/* -------------------------------------------------------------------------- */

describe('Affordance defaults', () => {
  it('own-view declaration is always at full level', () => {
    // own-view is intrinsically full — no level field on declaration
    const decl = parsed(ArtifactViewAffordanceDeclarationSchema, { kind: 'own-view' });
    expect(decl.kind).toBe('own-view');
    // No level property on the declaration
    expect((decl as Record<string, unknown>).level).toBeUndefined();
  });

  it('inline declaration-level matching: as is declaration policy', () => {
    const result = ArtifactViewAffordanceDeclarationSchema.safeParse({
      kind: 'inline',
      hostRelation: 'evidence',
      as: 'link',
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.kind === 'inline') {
      expect(result.data.as).toBe('link');
    }
  });
});
