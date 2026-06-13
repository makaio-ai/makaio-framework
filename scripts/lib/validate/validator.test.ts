import { describe, expect, it } from 'vitest';
import { getWorkerConfig, resolveWorkerTools } from './validator.js';

describe('getWorkerConfig', () => {
  it('keeps standalone workers on default sizing', () => {
    expect(getWorkerConfig('eslint', { profile: 'standalone' })).toEqual({ tool: 'eslint' });
    expect(getWorkerConfig('typescript', { profile: 'standalone' })).toEqual({ tool: 'typescript' });
  });

  it('uses full-workspace semantic worker limits', () => {
    expect(getWorkerConfig('eslint', { profile: 'full-workspace' })).toMatchObject({
      tool: 'eslint',
      timeoutMs: 1_800_000,
    });
    expect(getWorkerConfig('typescript', { profile: 'full-workspace' })).toMatchObject({
      tool: 'typescript',
      timeoutMs: 1_800_000,
    });
  });

  it('does not inflate format-only workers in the full workspace profile', () => {
    expect(getWorkerConfig('biome', { profile: 'full-workspace' })).toEqual({ tool: 'biome' });
    expect(getWorkerConfig('prettier', { profile: 'full-workspace' })).toEqual({ tool: 'prettier' });
    expect(getWorkerConfig('stylelint', { profile: 'full-workspace' })).toEqual({ tool: 'stylelint' });
  });
});

describe('resolveWorkerTools', () => {
  it('runs every validation tool by default', () => {
    expect(resolveWorkerTools({})).toEqual(['biome', 'eslint', 'stylelint', 'typescript']);
  });

  it('keeps the default validation tool list immutable across calls', () => {
    const tools = resolveWorkerTools({});
    tools.pop();

    expect(resolveWorkerTools({})).toEqual(['biome', 'eslint', 'stylelint', 'typescript']);
  });

  it('runs only explicitly selected validation tools', () => {
    expect(resolveWorkerTools({ tools: ['typescript'] })).toEqual(['typescript']);
    expect(resolveWorkerTools({ tools: ['eslint', 'biome'] })).toEqual(['eslint', 'biome']);
  });

  it('rejects an explicit empty validation tool selection', () => {
    expect(() => resolveWorkerTools({ tools: [] })).toThrow('tools must not be empty');
  });
});
