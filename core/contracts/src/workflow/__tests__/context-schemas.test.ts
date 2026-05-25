import { describe, expect, it } from 'vitest';
import {
  ArtifactQuerySourceSchema,
  BusRequestSourceSchema,
  ContextSourceSchema,
  ArtifactPublishTargetSchema,
  BusEventPublishTargetSchema,
  ContextPublishTargetSchema,
  ContextBundleSchema,
} from '../context.js';

// ─────────────────────────────────────────────────────────────
// ContextSource (Pull Pipeline)
// ─────────────────────────────────────────────────────────────

describe('ContextSourceSchema', () => {
  it('accepts an artifact-query source', () => {
    const result = ArtifactQuerySourceSchema.parse({
      type: 'artifact-query',
      filter: { type: 'station-output', 'metadata.station': 'requirements-analysis' },
      select: 'latest',
    });
    expect(result.type).toBe('artifact-query');
    expect(result.select).toBe('latest');
  });

  it('accepts an artifact-query source selecting all', () => {
    const result = ArtifactQuerySourceSchema.parse({
      type: 'artifact-query',
      filter: { type: 'station-feedback' },
      select: 'all',
      optional: true,
    });
    expect(result.select).toBe('all');
    expect(result.optional).toBe(true);
  });

  it('defaults optional to false when omitted', () => {
    const result = ArtifactQuerySourceSchema.parse({
      type: 'artifact-query',
      filter: { type: 'station-output' },
      select: 'latest',
    });
    expect(result.optional).toBeUndefined();
  });

  it('accepts a bus-request source', () => {
    const result = BusRequestSourceSchema.parse({
      type: 'bus-request',
      subject: 'workflow.context.resolve',
      payload: { station: 'architecture-design', iteration: 2 },
    });
    expect(result.type).toBe('bus-request');
    expect(result.subject).toBe('workflow.context.resolve');
  });

  it('rejects unknown source type', () => {
    expect(() =>
      ContextSourceSchema.parse({
        type: 'database',
        query: 'SELECT * FROM artifacts',
      }),
    ).toThrow();
  });

  it('rejects artifact-query without filter', () => {
    expect(() =>
      ContextSourceSchema.parse({
        type: 'artifact-query',
        select: 'latest',
      }),
    ).toThrow();
  });

  it('rejects artifact-query with invalid select', () => {
    expect(() =>
      ContextSourceSchema.parse({
        type: 'artifact-query',
        filter: { type: 'station-output' },
        select: 'first',
      }),
    ).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// ContextPublishTarget (Push Pipeline)
// ─────────────────────────────────────────────────────────────

describe('ContextPublishTargetSchema', () => {
  it('accepts an artifact publish target', () => {
    const result = ArtifactPublishTargetSchema.parse({
      type: 'artifact',
      artifactType: 'station-output',
      scope: 'workspace',
      metadata: { station: 'requirements-analysis' },
    });
    expect(result.type).toBe('artifact');
    expect(result.artifactType).toBe('station-output');
    expect(result.scope).toBe('workspace');
  });

  it('accepts a bus-event publish target', () => {
    const result = BusEventPublishTargetSchema.parse({
      type: 'bus-event',
      subject: 'workflow.station.completed',
    });
    expect(result.type).toBe('bus-event');
    expect(result.subject).toBe('workflow.station.completed');
  });

  it('rejects unknown publish type', () => {
    expect(() =>
      ContextPublishTargetSchema.parse({
        type: 'slack',
        channel: '#builds',
      }),
    ).toThrow();
  });

  it('rejects artifact target without artifactType', () => {
    expect(() =>
      ContextPublishTargetSchema.parse({
        type: 'artifact',
        scope: 'workspace',
      }),
    ).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// ContextBundle (resolved context ready for injection)
// ─────────────────────────────────────────────────────────────

describe('ContextBundleSchema', () => {
  it('accepts a bundle with resolved sources', () => {
    const result = ContextBundleSchema.parse({
      sources: {
        'requirements-analysis': {
          content: '## Findings\n- SAP timeout handling missing',
          metadata: { station: 'requirements-analysis', iteration: 1 },
        },
      },
    });
    expect(result.sources['requirements-analysis'].content).toContain('SAP timeout');
  });

  it('accepts an empty bundle', () => {
    const result = ContextBundleSchema.parse({ sources: {} });
    expect(Object.keys(result.sources)).toHaveLength(0);
  });

  it('accepts a bundle with multiple sources (fan-in)', () => {
    const result = ContextBundleSchema.parse({
      sources: {
        'architecture-design': {
          content: 'Component list: api-gateway, voucher-engine',
          metadata: { station: 'architecture-design', iteration: 2 },
        },
        'test-design': {
          content: 'Test plan: 12 acceptance criteria',
          metadata: { station: 'test-design', iteration: 1 },
        },
      },
    });
    expect(Object.keys(result.sources)).toHaveLength(2);
  });

  it('rejects missing sources key', () => {
    expect(() => ContextBundleSchema.parse({})).toThrow();
  });
});
