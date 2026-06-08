import { describe, expect, it } from 'vitest';
import { MaterializationSchemas, MaterializationSubjects } from '../namespace.js';
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
