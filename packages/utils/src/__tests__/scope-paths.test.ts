import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAKAIO_PERSONAL_DIR, MAKAIO_PROJECT_DIR, resolveScopePaths, type ResolvedScopePath } from '../scope-paths.js';

describe('resolveScopePaths', () => {
  it('returns only the global layer when no repo path is available', () => {
    const result = resolveScopePaths({
      asset: 'workflows',
      makaioHome: '/home/user/.makaio',
    });

    expect(result).toEqual<ResolvedScopePath[]>([
      { layer: 'global', path: path.join('/home/user/.makaio', 'workflows') },
    ]);
  });

  it('returns layers from broadest to narrowest when a repo path is available', () => {
    const result = resolveScopePaths({
      asset: 'workflows',
      makaioHome: '/home/user/.makaio',
      repoPath: '/code/project',
    });

    expect(result).toEqual<ResolvedScopePath[]>([
      { layer: 'global', path: path.join('/home/user/.makaio', 'workflows') },
      { layer: 'project', path: path.join('/code/project', '.makaio', 'workflows') },
      { layer: 'personal', path: path.join('/code/project', '.makaio', 'personal', 'workflows') },
    ]);
  });

  it('exports the project and personal directory names used by callers', () => {
    expect(MAKAIO_PROJECT_DIR).toBe('.makaio');
    expect(MAKAIO_PERSONAL_DIR).toBe('.makaio/personal');
  });

  it.each([
    '',
    '.',
    '..',
    '../workflows',
    'nested/workflows',
    'nested\\workflows',
    '/workflows',
  ])('rejects invalid asset name %j', (asset) => {
    expect(() =>
      resolveScopePaths({
        asset,
        makaioHome: '/home/user/.makaio',
        repoPath: '/code/project',
      }),
    ).toThrow(`Scope path asset must be a single relative directory name. Received: "${asset}"`);
  });
});
