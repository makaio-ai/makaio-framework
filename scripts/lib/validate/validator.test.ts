import { describe, expect, it } from 'vitest';
import { getWorkerConfig, resolveWorkerTools } from './validator.js';

describe('getWorkerConfig', () => {
  it('gives semantic workers the hang-detector timeout', () => {
    expect(getWorkerConfig('eslint')).toEqual({ tool: 'eslint', timeoutMs: 1_800_000 });
    expect(getWorkerConfig('typescript')).toEqual({ tool: 'typescript', timeoutMs: 1_800_000 });
  });

  it('applies the same semantic worker timeout on every validation topology', () => {
    const standalone = resolveWorkerTools({ profile: 'standalone' }).map((tool) => getWorkerConfig(tool));
    const fullWorkspace = resolveWorkerTools({ profile: 'full-workspace' }).map((tool) => getWorkerConfig(tool));

    expect(standalone).toEqual(fullWorkspace);
    expect(standalone).toContainEqual({ tool: 'eslint', timeoutMs: 1_800_000 });
    expect(standalone).toContainEqual({ tool: 'typescript', timeoutMs: 1_800_000 });
  });

  it('does not inflate format-only workers', () => {
    expect(getWorkerConfig('biome')).toEqual({ tool: 'biome' });
    expect(getWorkerConfig('prettier')).toEqual({ tool: 'prettier' });
    expect(getWorkerConfig('stylelint')).toEqual({ tool: 'stylelint' });
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
