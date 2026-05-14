import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveFrameworkPrefix } from './resolve-framework-prefix.js';

describe('resolveFrameworkPrefix', () => {
  it('returns framework when the script lives under a framework directory in a larger repository', () => {
    const repositoryRoot = resolve('/repo');
    const scriptDir = resolve('/repo/framework/scripts');

    expect(resolveFrameworkPrefix(scriptDir, repositoryRoot)).toBe('framework');
  });

  it('returns an empty prefix when the framework is the repository root', () => {
    const repositoryRoot = resolve('/repo');
    const scriptDir = resolve('/repo/scripts');

    expect(resolveFrameworkPrefix(scriptDir, repositoryRoot)).toBe('');
  });
});
