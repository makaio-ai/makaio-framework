import { describe, expect, it } from 'vitest';
import { checkPacklist } from './npm-packlist-policy.js';

describe('npm packlist policy', () => {
  it('accepts dist files plus package metadata', () => {
    const result = checkPacklist('@makaio/adapter-openai-node', [
      'package.json',
      'README.md',
      'LICENSE',
      'dist/index.js',
      'dist/index.d.ts',
      'descriptor.json',
    ]);
    expect(result.missingRequired).toEqual([]);
    expect(result.forbidden).toEqual([]);
  });

  it('rejects sourcemaps and source directories', () => {
    const result = checkPacklist('@makaio/adapter-openai-node', [
      'package.json',
      'README.md',
      'LICENSE',
      'dist/index.js',
      'dist/index.js.map',
      'src/index.ts',
    ]);
    expect(result.forbidden).toContain('dist/index.js.map');
    expect(result.forbidden).toContain('src/index.ts');
  });

  it('rejects tests, fixtures, build config, lockfiles, env files, and logs', () => {
    const result = checkPacklist('@makaio/test', [
      'package.json',
      'README.md',
      'LICENSE',
      '__tests__/foo.test.ts',
      'fixtures/data.json',
      'build.ts',
      'vite.config.ts',
      'tsconfig.json',
      'yarn.lock',
      '.env.local',
      'npm-debug.log',
    ]);
    expect(result.forbidden).toContain('__tests__/foo.test.ts');
    expect(result.forbidden).toContain('fixtures/data.json');
    expect(result.forbidden).toContain('build.ts');
    expect(result.forbidden).toContain('vite.config.ts');
    expect(result.forbidden).toContain('tsconfig.json');
    expect(result.forbidden).toContain('yarn.lock');
    expect(result.forbidden).toContain('.env.local');
    expect(result.forbidden).toContain('npm-debug.log');
  });

  it('reports missing README and LICENSE', () => {
    const result = checkPacklist('@makaio/test', ['package.json', 'dist/index.js']);
    expect(result.missingRequired).toContain('README.md');
    expect(result.missingRequired).toContain('LICENSE');
  });
});
