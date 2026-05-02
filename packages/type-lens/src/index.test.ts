import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTINUITY_CONFIG,
  createTypeviewChangeBatch,
  createSymbolId,
  type TypeviewChangeBatch,
  type TypeviewFileChange,
} from './index.js';

describe('@makaio/type-lens', () => {
  it('exports core contracts and deterministic helpers without service runtime dependencies', () => {
    const change: TypeviewFileChange = {
      absolutePath: '/workspace/src/index.ts',
      kind: 'change',
      relativePath: 'src/index.ts',
    };
    const batch: TypeviewChangeBatch = {
      changes: [change],
      scope: {
        branch: 'main',
        key: 'worktree:/workspace',
        path: '/workspace',
        type: 'worktree',
      },
    };

    expect(batch.changes).toEqual([change]);
    expect(DEFAULT_CONTINUITY_CONFIG.sameSymbolThreshold).toBeGreaterThan(0);
    expect(createSymbolId('worktree:/workspace', 'src/index.ts', 'Demo')).toBe(
      createSymbolId('worktree:/workspace', 'src/index.ts', 'Demo'),
    );
  });

  it('normalizes change batches deterministically by scope-relative path', () => {
    const batch = createTypeviewChangeBatch(
      {
        branch: 'main',
        key: 'worktree:/workspace',
        path: '/workspace',
        type: 'worktree',
      },
      [
        { absolutePath: '/workspace/b.ts', kind: 'change' },
        { absolutePath: '/workspace/a.ts', kind: 'create' },
        { absolutePath: '/workspace/b.ts', kind: 'delete' },
      ],
    );

    expect(batch.changes).toEqual([
      { absolutePath: '/workspace/a.ts', kind: 'create', relativePath: 'a.ts' },
      { absolutePath: '/workspace/b.ts', kind: 'delete', relativePath: 'b.ts' },
    ]);
  });

  it('rejects change paths outside the scope root', () => {
    expect(() =>
      createTypeviewChangeBatch(
        {
          branch: 'main',
          key: 'worktree:/workspace',
          path: '/workspace',
          type: 'worktree',
        },
        [{ absolutePath: '/other/file.ts', kind: 'change' }],
      ),
    ).toThrow(/within scope root/);
  });
});
