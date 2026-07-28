import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkerContributionRef } from '@makaio/contracts';
import {
  computeDirectoryDigest,
  computeContributionPackageDigest,
  materializeLocalDirectory,
  MaterializationError,
  type WorkspaceRootResolver,
} from '../local-directory-materializer.js';

// ─────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────

/** Temp directory root for each test. */
let tmpRoot: string;

/** Workspace root inside the temp directory. */
let workspaceRoot: string;

/**
 * Create a file at the given path relative to the workspace root with
 * the provided content, creating parent directories as needed.
 * @param relativePath - Workspace-relative file path.
 * @param content - File content.
 */
async function writeWorkspaceFile(relativePath: string, content: string): Promise<void> {
  const fullPath = path.join(workspaceRoot, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, 'utf-8');
}

/**
 * Create a minimal `package.json` for a contribution package.
 * @param packageName - Package name.
 * @param version - Package version.
 * @param entrypoint - Package-relative entrypoint path.
 * @param entrypointContent - Content to write to the entrypoint file.
 */
async function writeContributionPackage(
  packageName: string,
  version: string,
  entrypoint: string,
  entrypointContent: string,
): Promise<void> {
  const packageDir = path.join(workspaceRoot, 'node_modules', packageName);
  await fs.mkdir(packageDir, { recursive: true });
  await fs.writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ name: packageName, version }), 'utf-8');
  const entrypointPath = path.join(packageDir, entrypoint);
  await fs.mkdir(path.dirname(entrypointPath), { recursive: true });
  await fs.writeFile(entrypointPath, entrypointContent, 'utf-8');
}

/**
 * Compute the package-content integrity for a contribution fixture.
 * @param packageName - Contribution package name.
 * @returns SRI-format package digest.
 */
async function computeContributionIntegrity(packageName: string): Promise<string> {
  return computeContributionPackageDigest(path.join(workspaceRoot, 'node_modules', packageName), 'sha384');
}

/**
 * Create a workspace root resolver that maps a single workspace ID to the
 * test workspace root.
 * @param allowedId - The workspace ID to allow.
 * @returns A workspace root resolver.
 */
function createResolver(allowedId: string): WorkspaceRootResolver {
  return async (workspaceId: string) => {
    if (workspaceId === allowedId) {
      return workspaceRoot;
    }
    return undefined;
  };
}

// ─────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'local-dir-materializer-'));
  workspaceRoot = path.join(tmpRoot, 'workspace');
  await fs.mkdir(workspaceRoot, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────

describe('materializeLocalDirectory', () => {
  describe('root containment', () => {
    it('rejects unknown workspace IDs', async () => {
      await writeWorkspaceFile('workflow.ts', 'export default {}');
      const digest = await computeDirectoryDigest(workspaceRoot);

      await expect(
        materializeLocalDirectory(
          {
            kind: 'local-directory',
            workspaceId: 'unknown-ws',
            rootDigest: digest,
            sourcePath: 'workflow.ts',
          },
          [],
          { resolveWorkspaceRoot: createResolver('known-ws') },
        ),
      ).rejects.toThrow(MaterializationError);

      await expect(
        materializeLocalDirectory(
          {
            kind: 'local-directory',
            workspaceId: 'unknown-ws',
            rootDigest: digest,
            sourcePath: 'workflow.ts',
          },
          [],
          { resolveWorkspaceRoot: createResolver('known-ws') },
        ),
      ).rejects.toMatchObject({ code: 'unknown-workspace' });
    });

    it('rejects source path that escapes the workspace root', async () => {
      await writeWorkspaceFile('workflow.ts', 'export default {}');
      const digest = await computeDirectoryDigest(workspaceRoot);

      await expect(
        materializeLocalDirectory(
          {
            kind: 'local-directory',
            workspaceId: 'ws-1',
            rootDigest: digest,
            sourcePath: '../../../etc/passwd',
          },
          [],
          { resolveWorkspaceRoot: createResolver('ws-1') },
        ),
      ).rejects.toMatchObject({ code: 'containment-violation' });
    });

    it('rejects workspace root that does not exist', async () => {
      const nonexistent = path.join(tmpRoot, 'nonexistent');

      await expect(
        materializeLocalDirectory(
          {
            kind: 'local-directory',
            workspaceId: 'ws-1',
            rootDigest: 'sha256-fake',
            sourcePath: 'workflow.ts',
          },
          [],
          {
            resolveWorkspaceRoot: async () => nonexistent,
          },
        ),
      ).rejects.toMatchObject({ code: 'containment-violation' });
    });
  });

  describe('symlink escape', () => {
    it('rejects source path that escapes via symlink', async () => {
      // Create a file outside the workspace
      const outsideFile = path.join(tmpRoot, 'secret.txt');
      await fs.writeFile(outsideFile, 'secret data');

      // Create a symlink inside the workspace pointing outside
      await fs.symlink(outsideFile, path.join(workspaceRoot, 'workflow.ts'));

      const digest = await computeDirectoryDigest(workspaceRoot);

      await expect(
        materializeLocalDirectory(
          {
            kind: 'local-directory',
            workspaceId: 'ws-1',
            rootDigest: digest,
            sourcePath: 'workflow.ts',
          },
          [],
          { resolveWorkspaceRoot: createResolver('ws-1') },
        ),
      ).rejects.toMatchObject({ code: 'symlink-escape' });
    });
  });

  describe('digest drift', () => {
    it('rejects when workspace root digest does not match', async () => {
      await writeWorkspaceFile('workflow.ts', 'export default {}');

      await expect(
        materializeLocalDirectory(
          {
            kind: 'local-directory',
            workspaceId: 'ws-1',
            rootDigest: 'sha256-wrongdigestvalue',
            sourcePath: 'workflow.ts',
          },
          [],
          { resolveWorkspaceRoot: createResolver('ws-1') },
        ),
      ).rejects.toMatchObject({ code: 'digest-mismatch' });
    });

    it('detects content changes after initial materialization', async () => {
      await writeWorkspaceFile('workflow.ts', 'export default {}');
      const digest = await computeDirectoryDigest(workspaceRoot);

      // First materialization succeeds
      const ctx = await materializeLocalDirectory(
        {
          kind: 'local-directory',
          workspaceId: 'ws-1',
          rootDigest: digest,
          sourcePath: 'workflow.ts',
        },
        [],
        { resolveWorkspaceRoot: createResolver('ws-1') },
      );
      expect(ctx.workspaceRoot).toBe(workspaceRoot);

      // Modify a file to change the digest
      await writeWorkspaceFile('workflow.ts', 'export default { changed: true }');

      // Second materialization fails due to digest drift
      await expect(
        materializeLocalDirectory(
          {
            kind: 'local-directory',
            workspaceId: 'ws-1',
            rootDigest: digest,
            sourcePath: 'workflow.ts',
          },
          [],
          { resolveWorkspaceRoot: createResolver('ws-1') },
        ),
      ).rejects.toMatchObject({ code: 'digest-mismatch' });
    });

    it('detects changes to Factory workflow sources in hidden directories', async () => {
      await writeWorkspaceFile('.factory/workflows/review.ts', 'export default {}');
      const digest = await computeDirectoryDigest(workspaceRoot);

      await writeWorkspaceFile('.factory/workflows/review.ts', 'export default { changed: true }');

      await expect(
        materializeLocalDirectory(
          {
            kind: 'local-directory',
            workspaceId: 'ws-1',
            rootDigest: digest,
            sourcePath: '.factory/workflows/review.ts',
          },
          [],
          { resolveWorkspaceRoot: createResolver('ws-1') },
        ),
      ).rejects.toMatchObject({ code: 'digest-mismatch' });
    });
  });

  describe('source file', () => {
    it('rejects when source file does not exist', async () => {
      await writeWorkspaceFile('other.ts', 'export default {}');
      const digest = await computeDirectoryDigest(workspaceRoot);

      await expect(
        materializeLocalDirectory(
          {
            kind: 'local-directory',
            workspaceId: 'ws-1',
            rootDigest: digest,
            sourcePath: 'missing-workflow.ts',
          },
          [],
          { resolveWorkspaceRoot: createResolver('ws-1') },
        ),
      ).rejects.toMatchObject({ code: 'source-missing' });
    });
  });

  describe('contribution verification', () => {
    it('rejects when contribution package is missing', async () => {
      await writeWorkspaceFile('workflow.ts', 'export default {}');
      const digest = await computeDirectoryDigest(workspaceRoot);

      const ref: WorkerContributionRef = {
        packageName: '@acme/tools',
        version: '1.0.0',
        entrypoint: 'dist/server.mjs',
        integrity: 'sha384-fake',
      };

      await expect(
        materializeLocalDirectory(
          {
            kind: 'local-directory',
            workspaceId: 'ws-1',
            rootDigest: digest,
            sourcePath: 'workflow.ts',
          },
          [ref],
          { resolveWorkspaceRoot: createResolver('ws-1') },
        ),
      ).rejects.toMatchObject({ code: 'contribution-missing' });
    });

    it('rejects when contribution version does not match', async () => {
      const entrypointContent = 'export const tool = () => {}';
      await writeContributionPackage(
        '@acme/tools',
        '2.0.0', // Wrong version
        'dist/server.mjs',
        entrypointContent,
      );
      await writeWorkspaceFile('workflow.ts', 'export default {}');
      const digest = await computeDirectoryDigest(workspaceRoot);

      const ref: WorkerContributionRef = {
        packageName: '@acme/tools',
        version: '1.0.0',
        entrypoint: 'dist/server.mjs',
        integrity: await computeContributionIntegrity('@acme/tools'),
      };

      await expect(
        materializeLocalDirectory(
          {
            kind: 'local-directory',
            workspaceId: 'ws-1',
            rootDigest: digest,
            sourcePath: 'workflow.ts',
          },
          [ref],
          { resolveWorkspaceRoot: createResolver('ws-1') },
        ),
      ).rejects.toMatchObject({ code: 'contribution-version-mismatch' });
    });

    it('rejects when contribution entrypoint does not exist', async () => {
      const packageDir = path.join(workspaceRoot, 'node_modules', '@acme/tools');
      await fs.mkdir(packageDir, { recursive: true });
      await fs.writeFile(
        path.join(packageDir, 'package.json'),
        JSON.stringify({ name: '@acme/tools', version: '1.0.0' }),
        'utf-8',
      );
      // Do NOT create the entrypoint file
      await writeWorkspaceFile('workflow.ts', 'export default {}');
      const digest = await computeDirectoryDigest(workspaceRoot);

      const ref: WorkerContributionRef = {
        packageName: '@acme/tools',
        version: '1.0.0',
        entrypoint: 'dist/server.mjs',
        integrity: 'sha384-fake',
      };

      await expect(
        materializeLocalDirectory(
          {
            kind: 'local-directory',
            workspaceId: 'ws-1',
            rootDigest: digest,
            sourcePath: 'workflow.ts',
          },
          [ref],
          { resolveWorkspaceRoot: createResolver('ws-1') },
        ),
      ).rejects.toMatchObject({ code: 'contribution-entrypoint-mismatch' });
    });

    it('rejects traversal packageName that escapes the workspace root', async () => {
      // A malicious packageName like '../../..' could resolve outside node_modules
      await writeWorkspaceFile('workflow.ts', 'export default {}');
      const digest = await computeDirectoryDigest(workspaceRoot);

      const ref: WorkerContributionRef = {
        packageName: '../../../etc',
        version: '1.0.0',
        entrypoint: 'passwd',
        integrity: 'sha384-fake',
      };

      await expect(
        materializeLocalDirectory(
          {
            kind: 'local-directory',
            workspaceId: 'ws-1',
            rootDigest: digest,
            sourcePath: 'workflow.ts',
          },
          [ref],
          { resolveWorkspaceRoot: createResolver('ws-1') },
        ),
      ).rejects.toMatchObject({ code: 'containment-violation' });
    });

    it('rejects symlinked contribution package dir escaping the workspace root', async () => {
      // Create a package directory outside the workspace
      const outsideDir = path.join(tmpRoot, 'outside-pkg');
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.writeFile(
        path.join(outsideDir, 'package.json'),
        JSON.stringify({ name: '@acme/evil', version: '1.0.0' }),
        'utf-8',
      );
      const entrypointContent = 'export const tool = () => {}';
      await fs.mkdir(path.join(outsideDir, 'dist'), { recursive: true });
      await fs.writeFile(path.join(outsideDir, 'dist/server.mjs'), entrypointContent, 'utf-8');

      // Create a symlink inside node_modules pointing outside
      const symlinkTarget = path.join(workspaceRoot, 'node_modules', '@acme', 'evil');
      await fs.mkdir(path.dirname(symlinkTarget), { recursive: true });
      await fs.symlink(outsideDir, symlinkTarget);

      await writeWorkspaceFile('workflow.ts', 'export default {}');
      const digest = await computeDirectoryDigest(workspaceRoot);

      const ref: WorkerContributionRef = {
        packageName: '@acme/evil',
        version: '1.0.0',
        entrypoint: 'dist/server.mjs',
        integrity: await computeContributionIntegrity('@acme/evil'),
      };

      await expect(
        materializeLocalDirectory(
          {
            kind: 'local-directory',
            workspaceId: 'ws-1',
            rootDigest: digest,
            sourcePath: 'workflow.ts',
          },
          [ref],
          { resolveWorkspaceRoot: createResolver('ws-1') },
        ),
      ).rejects.toMatchObject({ code: 'symlink-escape' });
    });

    it('rejects when contribution integrity does not match', async () => {
      const entrypointContent = 'export const tool = () => {}';
      await writeContributionPackage('@acme/tools', '1.0.0', 'dist/server.mjs', entrypointContent);
      await writeWorkspaceFile('workflow.ts', 'export default {}');
      const digest = await computeDirectoryDigest(workspaceRoot);

      const ref: WorkerContributionRef = {
        packageName: '@acme/tools',
        version: '1.0.0',
        entrypoint: 'dist/server.mjs',
        integrity: 'sha384-WRONG_DIGEST_VALUE_HERE=',
      };

      await expect(
        materializeLocalDirectory(
          {
            kind: 'local-directory',
            workspaceId: 'ws-1',
            rootDigest: digest,
            sourcePath: 'workflow.ts',
          },
          [ref],
          { resolveWorkspaceRoot: createResolver('ws-1') },
        ),
      ).rejects.toMatchObject({ code: 'contribution-integrity-mismatch' });
    });

    it('rejects a changed transitive helper while the entrypoint is unchanged', async () => {
      const entrypointContent = `import { tool } from './helper.mjs'; export { tool };`;
      await writeContributionPackage('@acme/tools', '1.0.0', 'dist/server.mjs', entrypointContent);
      await writeWorkspaceFile('node_modules/@acme/tools/dist/helper.mjs', 'export const tool = () => "original";');
      await writeWorkspaceFile('workflow.ts', 'export default {};');
      const integrity = await computeContributionIntegrity('@acme/tools');
      const digest = await computeDirectoryDigest(workspaceRoot);

      await writeWorkspaceFile('node_modules/@acme/tools/dist/helper.mjs', 'export const tool = () => "tampered";');

      await expect(
        materializeLocalDirectory(
          {
            kind: 'local-directory',
            workspaceId: 'ws-1',
            rootDigest: digest,
            sourcePath: 'workflow.ts',
          },
          [
            {
              packageName: '@acme/tools',
              version: '1.0.0',
              entrypoint: 'dist/server.mjs',
              integrity,
            },
          ],
          { resolveWorkspaceRoot: createResolver('ws-1') },
        ),
      ).rejects.toMatchObject({ code: 'contribution-integrity-mismatch' });
    });
  });

  describe('retry / idempotent re-materialization', () => {
    it('returns equivalent context on idempotent retry', async () => {
      const entrypointContent = 'export const tool = () => {}';
      await writeContributionPackage('@acme/tools', '1.0.0', 'dist/server.mjs', entrypointContent);
      await writeWorkspaceFile('workflow.ts', 'export default {}');
      const digest = await computeDirectoryDigest(workspaceRoot);

      const ref: WorkerContributionRef = {
        packageName: '@acme/tools',
        version: '1.0.0',
        entrypoint: 'dist/server.mjs',
        integrity: await computeContributionIntegrity('@acme/tools'),
      };
      const spec = {
        kind: 'local-directory' as const,
        workspaceId: 'ws-1',
        rootDigest: digest,
        sourcePath: 'workflow.ts',
      };
      const opts = { resolveWorkspaceRoot: createResolver('ws-1') };

      const ctx1 = await materializeLocalDirectory(spec, [ref], opts);
      const ctx2 = await materializeLocalDirectory(spec, [ref], opts);

      expect(ctx1.workspaceRoot).toBe(ctx2.workspaceRoot);
      expect(ctx1.sourcePath).toBe(ctx2.sourcePath);
      expect(ctx1.contributionEntrypoints).toEqual(ctx2.contributionEntrypoints);
      expect(ctx1.platform).toBe(ctx2.platform);
      expect(ctx1.arch).toBe(ctx2.arch);
    });
  });

  describe('successful materialization', () => {
    it('returns verified runtime context with absolute paths', async () => {
      const entrypointContent = 'export const tool = () => {}';
      await writeContributionPackage('@acme/tools', '1.0.0', 'dist/server.mjs', entrypointContent);
      await writeWorkspaceFile('src/workflow.ts', 'export default {}');
      const digest = await computeDirectoryDigest(workspaceRoot);

      const ref: WorkerContributionRef = {
        packageName: '@acme/tools',
        version: '1.0.0',
        entrypoint: 'dist/server.mjs',
        integrity: await computeContributionIntegrity('@acme/tools'),
      };

      const ctx = await materializeLocalDirectory(
        {
          kind: 'local-directory',
          workspaceId: 'ws-1',
          rootDigest: digest,
          sourcePath: 'src/workflow.ts',
        },
        [ref],
        { resolveWorkspaceRoot: createResolver('ws-1') },
      );

      expect(ctx.workspaceRoot).toBe(workspaceRoot);
      expect(ctx.sourcePath).toBe(path.join(workspaceRoot, 'src/workflow.ts'));
      expect(ctx.contributionEntrypoints).toHaveLength(1);
      expect(ctx.contributionEntrypoints[0]).toBe(
        path.join(workspaceRoot, 'node_modules', '@acme/tools', 'dist/server.mjs'),
      );
      expect(ctx.platform).toBe(process.platform);
      expect(ctx.arch).toBe(process.arch);
    });

    it('handles multiple contributions in order', async () => {
      const content1 = 'export const tool1 = () => {}';
      const content2 = 'export const tool2 = () => {}';
      await writeContributionPackage('@acme/tools', '1.0.0', 'dist/server.mjs', content1);
      await writeContributionPackage('@acme/analytics', '2.3.0', 'lib/index.js', content2);
      await writeWorkspaceFile('workflow.ts', 'export default {}');
      const digest = await computeDirectoryDigest(workspaceRoot);

      const refs: WorkerContributionRef[] = [
        {
          packageName: '@acme/tools',
          version: '1.0.0',
          entrypoint: 'dist/server.mjs',
          integrity: await computeContributionIntegrity('@acme/tools'),
        },
        {
          packageName: '@acme/analytics',
          version: '2.3.0',
          entrypoint: 'lib/index.js',
          integrity: await computeContributionIntegrity('@acme/analytics'),
        },
      ];

      const ctx = await materializeLocalDirectory(
        {
          kind: 'local-directory',
          workspaceId: 'ws-1',
          rootDigest: digest,
          sourcePath: 'workflow.ts',
        },
        refs,
        { resolveWorkspaceRoot: createResolver('ws-1') },
      );

      expect(ctx.contributionEntrypoints).toHaveLength(2);
      expect(ctx.contributionEntrypoints[0]).toContain('@acme/tools');
      expect(ctx.contributionEntrypoints[1]).toContain('@acme/analytics');
    });

    it('returns empty contribution entrypoints when no contributions provided', async () => {
      await writeWorkspaceFile('workflow.ts', 'export default {}');
      const digest = await computeDirectoryDigest(workspaceRoot);

      const ctx = await materializeLocalDirectory(
        {
          kind: 'local-directory',
          workspaceId: 'ws-1',
          rootDigest: digest,
          sourcePath: 'workflow.ts',
        },
        [],
        { resolveWorkspaceRoot: createResolver('ws-1') },
      );

      expect(ctx.contributionEntrypoints).toEqual([]);
    });
  });
});

describe('computeDirectoryDigest', () => {
  it('produces deterministic SRI-format digests', async () => {
    await writeWorkspaceFile('a.txt', 'hello');
    await writeWorkspaceFile('b.txt', 'world');

    const digest1 = await computeDirectoryDigest(workspaceRoot);
    const digest2 = await computeDirectoryDigest(workspaceRoot);

    expect(digest1).toBe(digest2);
    expect(digest1).toMatch(/^sha256-.+$/);
  });

  it('changes when file content changes', async () => {
    await writeWorkspaceFile('a.txt', 'original');
    const digest1 = await computeDirectoryDigest(workspaceRoot);

    await writeWorkspaceFile('a.txt', 'modified');
    const digest2 = await computeDirectoryDigest(workspaceRoot);

    expect(digest1).not.toBe(digest2);
  });

  it('produces different digests for ambiguous path/content concatenations', async () => {
    // Without framing, ('a','bc') and ('ab','c') could produce the same digest.
    // Create two separate directories with files whose paths+content are
    // ambiguous under naive concatenation.
    const dir1 = path.join(tmpRoot, 'digest-dir1');
    const dir2 = path.join(tmpRoot, 'digest-dir2');
    await fs.mkdir(dir1, { recursive: true });
    await fs.mkdir(dir2, { recursive: true });

    // dir1 has file 'a' with content 'bc'
    await fs.writeFile(path.join(dir1, 'a'), 'bc', 'utf-8');
    // dir2 has file 'ab' with content 'c'
    await fs.writeFile(path.join(dir2, 'ab'), 'c', 'utf-8');

    const digest1 = await computeDirectoryDigest(dir1);
    const digest2 = await computeDirectoryDigest(dir2);

    expect(digest1).not.toBe(digest2);
  });

  it('ignores only explicit volatile directories', async () => {
    await writeWorkspaceFile('workflow.ts', 'export default {}');
    const digest1 = await computeDirectoryDigest(workspaceRoot);

    await writeWorkspaceFile('node_modules/pkg/index.js', 'module.exports=1');
    await writeWorkspaceFile('.git/config', '[core]');
    const digest2 = await computeDirectoryDigest(workspaceRoot);

    expect(digest1).toBe(digest2);
  });

  it('materializes a linked Git worktree using the primary checkout digest', async () => {
    await writeWorkspaceFile('workflow.ts', 'export default {}');
    execFileSync('git', ['init', '--quiet'], { cwd: workspaceRoot });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: workspaceRoot });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: workspaceRoot });
    execFileSync('git', ['add', '.'], { cwd: workspaceRoot });
    execFileSync('git', ['commit', '--quiet', '-m', 'initial'], { cwd: workspaceRoot });

    const linkedWorktree = path.join(tmpRoot, 'linked-worktree');
    execFileSync('git', ['worktree', 'add', '--quiet', '--detach', linkedWorktree, 'HEAD'], { cwd: workspaceRoot });

    try {
      const rootDigest = await computeDirectoryDigest(workspaceRoot);
      expect(await computeDirectoryDigest(linkedWorktree)).toBe(rootDigest);

      await expect(
        materializeLocalDirectory(
          {
            kind: 'local-directory',
            workspaceId: 'linked-worktree',
            rootDigest,
            sourcePath: 'workflow.ts',
          },
          [],
          { resolveWorkspaceRoot: async () => linkedWorktree },
        ),
      ).resolves.toMatchObject({ workspaceRoot: linkedWorktree, sourcePath: path.join(linkedWorktree, 'workflow.ts') });
    } finally {
      execFileSync('git', ['worktree', 'remove', '--force', linkedWorktree], { cwd: workspaceRoot });
    }
  });

  it('includes hidden directories that are not explicitly volatile', async () => {
    await writeWorkspaceFile('workflow.ts', 'export default {}');
    const digest1 = await computeDirectoryDigest(workspaceRoot);

    await writeWorkspaceFile('.factory/workflows/review.ts', 'export default {}');
    const digest2 = await computeDirectoryDigest(workspaceRoot);

    expect(digest1).not.toBe(digest2);
  });
});
