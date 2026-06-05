import { describe, expect, it } from 'vitest';
import { mergeExecutionHints } from '../workflow-execution-start.js';
import type { ExecutionHints } from '@makaio/contracts';

describe('mergeExecutionHints', () => {
  it('returns undefined when both sources are undefined', () => {
    expect(mergeExecutionHints(undefined, undefined)).toBeUndefined();
  });

  it('returns definition hints when request hints are undefined', () => {
    const definitionHints: ExecutionHints = {
      requirements: { isolation: 'container', capabilities: ['docker'] },
      providers: { 'github-actions': { pool: 'large' } },
    };
    expect(mergeExecutionHints(definitionHints, undefined)).toEqual(definitionHints);
  });

  it('returns request hints when definition hints are undefined', () => {
    const requestHints: ExecutionHints = {
      requirements: { isolation: 'remote' },
      providers: { 'github-actions': { pool: 'expensive-runner' } },
    };
    expect(mergeExecutionHints(undefined, requestHints)).toEqual(requestHints);
  });

  it('unions capabilities from both sources and deduplicates', () => {
    const definitionHints: ExecutionHints = {
      requirements: { capabilities: ['docker', 'gpu'] },
    };
    const requestHints: ExecutionHints = {
      requirements: { capabilities: ['gpu', 'arm64'] },
    };
    const result = mergeExecutionHints(definitionHints, requestHints);
    expect(result?.requirements?.capabilities).toEqual(['docker', 'gpu', 'arm64']);
  });

  it('request scalars override definition scalars', () => {
    const definitionHints: ExecutionHints = {
      requirements: { isolation: 'local' },
    };
    const requestHints: ExecutionHints = {
      requirements: { isolation: 'container' },
    };
    const result = mergeExecutionHints(definitionHints, requestHints);
    expect(result?.requirements?.isolation).toBe('container');
  });

  it('shallow-merges providers so definition keys survive when absent from request', () => {
    const definitionHints: ExecutionHints = {
      providers: {
        'github-actions': { pool: 'default' },
        'local-worker': { threads: 4 },
      },
    };
    const requestHints: ExecutionHints = {
      providers: {
        'github-actions': { pool: 'expensive-runner' },
      },
    };
    const result = mergeExecutionHints(definitionHints, requestHints);
    expect(result?.providers).toEqual({
      'github-actions': { pool: 'expensive-runner' },
      'local-worker': { threads: 4 },
    });
  });

  it('request provider entries override definition entries for the same key', () => {
    const definitionHints: ExecutionHints = {
      providers: { 'github-actions': { pool: 'default', timeout: 30 } },
    };
    const requestHints: ExecutionHints = {
      providers: { 'github-actions': { pool: 'large' } },
    };
    const result = mergeExecutionHints(definitionHints, requestHints);
    // Provider values are opaque JSON — the whole value for a key is replaced
    expect(result?.providers?.['github-actions']).toEqual({ pool: 'large' });
  });

  it('request source overrides definition source', () => {
    const definitionHints: ExecutionHints = {
      source: { kind: 'path', path: '.makaio/workflows/default.ts' },
    };
    const requestHints: ExecutionHints = {
      source: { kind: 'path', path: '.makaio/workflows/override.ts' },
    };
    const result = mergeExecutionHints(definitionHints, requestHints);
    expect(result?.source).toEqual({ kind: 'path', path: '.makaio/workflows/override.ts' });
  });

  it('preserves extra catchall fields from both sources, request wins', () => {
    const definitionHints: ExecutionHints = { priority: 'low', timeout: 60 } as ExecutionHints;
    const requestHints: ExecutionHints = { priority: 'high' } as ExecutionHints;
    const result = mergeExecutionHints(definitionHints, requestHints);
    expect((result as Record<string, unknown>)['priority']).toBe('high');
    expect((result as Record<string, unknown>)['timeout']).toBe(60);
  });
});
