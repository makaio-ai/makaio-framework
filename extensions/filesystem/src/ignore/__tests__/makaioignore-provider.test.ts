import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createMakaioIgnoreProvider } from '../makaioignore-provider.js';
import { useTempDir } from '../../tools/__tests__/test-helpers.js';

const createTempDir = useTempDir('makaioignore-provider-');

/** Create a provider with global ignore disabled (isolates tests from host machine). */
function createIsolatedProvider() {
  return createMakaioIgnoreProvider({ globalIgnorePath: null });
}

describe('createMakaioIgnoreProvider', () => {
  it('denies files matching a pattern in .makaioignore at cwd', async () => {
    const dir = await createTempDir();
    await fs.writeFile(path.join(dir, '.makaioignore'), '*.secret\n');

    const provider = createIsolatedProvider();
    const rules = await provider(dir, []);

    expect(rules.isDenied(path.join(dir, 'foo.secret'))).toBe(true);
    expect(rules.isDenied(path.join(dir, 'foo.txt'))).toBe(false);
  });

  it('allows negated files when descendant .makaioignore overrides an ancestor pattern', async () => {
    const parentDir = await createTempDir();
    const childDir = path.join(parentDir, 'child');
    await fs.mkdir(childDir);

    await fs.writeFile(path.join(parentDir, '.makaioignore'), '*.log\n');
    await fs.writeFile(path.join(childDir, '.makaioignore'), '!important.log\n');

    const provider = createIsolatedProvider();
    const rules = await provider(childDir, []);

    expect(rules.isDenied(path.join(childDir, 'important.log'))).toBe(false);
    expect(rules.isDenied(path.join(childDir, 'other.log'))).toBe(true);
  });

  it('applies ancestor patterns relative to the ancestor directory', async () => {
    const parentDir = await createTempDir();
    const childDir = path.join(parentDir, 'child');
    await fs.mkdir(childDir);

    // This pattern is scoped to the parent directory and should match child/*.
    await fs.writeFile(path.join(parentDir, '.makaioignore'), 'child/*.env\n');

    const provider = createIsolatedProvider();
    const rules = await provider(childDir, []);

    expect(rules.isDenied(path.join(childDir, '.env'))).toBe(true);
    expect(rules.isDenied(path.join(childDir, 'README.md'))).toBe(false);
  });

  it('denies .env via default patterns even with no .makaioignore file', async () => {
    const dir = await createTempDir();

    const provider = createIsolatedProvider();
    const rules = await provider(dir, []);

    expect(rules.isDenied(path.join(dir, '.env'))).toBe(true);
  });

  it('allows .env when negated in .makaioignore', async () => {
    const dir = await createTempDir();
    await fs.writeFile(path.join(dir, '.makaioignore'), '!.env\n');

    const provider = createIsolatedProvider();
    const rules = await provider(dir, []);

    expect(rules.isDenied(path.join(dir, '.env'))).toBe(false);
  });

  it('works with no .makaioignore files at all — only defaults apply', async () => {
    const dir = await createTempDir();

    const provider = createIsolatedProvider();
    const rules = await provider(dir, []);

    // Default patterns deny .env
    expect(rules.isDenied(path.join(dir, '.env'))).toBe(true);
    // Arbitrary files are allowed
    expect(rules.isDenied(path.join(dir, 'README.md'))).toBe(false);
  });

  it('picks up changes after .makaioignore is modified (cache invalidation)', async () => {
    const dir = await createTempDir();
    const ignoreFile = path.join(dir, '.makaioignore');
    await fs.writeFile(ignoreFile, '*.secret\n');

    const provider = createIsolatedProvider();

    const rulesBefore = await provider(dir, []);
    expect(rulesBefore.isDenied(path.join(dir, 'notes.txt'))).toBe(false);

    // Ensure mtime changes on coarse filesystems (some use 1s resolution).
    await new Promise<void>((resolve) => setTimeout(resolve, 1050));
    await fs.writeFile(ignoreFile, '*.secret\n*.txt\n');

    const rulesAfter = await provider(dir, []);
    expect(rulesAfter.isDenied(path.join(dir, 'notes.txt'))).toBe(true);
  });

  it('returns false for paths outside cwd even when the pattern would match', async () => {
    const dir = await createTempDir();
    await fs.writeFile(path.join(dir, '.makaioignore'), '*.secret\n');

    const provider = createIsolatedProvider();
    const rules = await provider(dir, []);

    // Path is completely outside cwd — must not be denied by pattern matching
    expect(rules.isDenied('/completely/outside/path/foo.secret')).toBe(false);
  });

  it('passes allowedDirectories through to the returned rules unchanged', async () => {
    const dir = await createTempDir();
    const allowed = ['/home/user/projects', '/tmp/work'];

    const provider = createIsolatedProvider();
    const rules = await provider(dir, allowed);

    expect(rules.allowedDirectories).toEqual(allowed);
  });

  describe('global ignore (~/.makaio/.makaioignore)', () => {
    it('denies files matching a pattern in the global ignore file', async () => {
      const dir = await createTempDir();
      const globalDir = await createTempDir();
      const globalIgnorePath = path.join(globalDir, '.makaioignore');
      await fs.writeFile(globalIgnorePath, '*.company-secret\n');

      const provider = createMakaioIgnoreProvider({ globalIgnorePath });
      const rules = await provider(dir, []);

      expect(rules.isDenied(path.join(dir, 'data.company-secret'))).toBe(true);
      expect(rules.isDenied(path.join(dir, 'data.txt'))).toBe(false);
    });

    it('project .makaioignore can negate global patterns', async () => {
      const dir = await createTempDir();
      const globalDir = await createTempDir();
      const globalIgnorePath = path.join(globalDir, '.makaioignore');
      await fs.writeFile(globalIgnorePath, '*.dat\n');
      await fs.writeFile(path.join(dir, '.makaioignore'), '!important.dat\n');

      const provider = createMakaioIgnoreProvider({ globalIgnorePath });
      const rules = await provider(dir, []);

      expect(rules.isDenied(path.join(dir, 'important.dat'))).toBe(false);
      expect(rules.isDenied(path.join(dir, 'other.dat'))).toBe(true);
    });

    it('global ignore can negate default patterns', async () => {
      const dir = await createTempDir();
      const globalDir = await createTempDir();
      const globalIgnorePath = path.join(globalDir, '.makaioignore');
      await fs.writeFile(globalIgnorePath, '!.env\n');

      const provider = createMakaioIgnoreProvider({ globalIgnorePath });
      const rules = await provider(dir, []);

      // Default denies .env, but global negates it
      expect(rules.isDenied(path.join(dir, '.env'))).toBe(false);
    });

    it('works when global ignore file does not exist', async () => {
      const dir = await createTempDir();
      const nonExistentPath = path.join(dir, 'no-such-dir', '.makaioignore');

      const provider = createMakaioIgnoreProvider({ globalIgnorePath: nonExistentPath });
      const rules = await provider(dir, []);

      // Should still apply defaults
      expect(rules.isDenied(path.join(dir, '.env'))).toBe(true);
      expect(rules.isDenied(path.join(dir, 'README.md'))).toBe(false);
    });

    it('globalIgnorePath: null disables global ignore loading', async () => {
      const dir = await createTempDir();

      // null explicitly disables — no stat() call for global path
      const provider = createMakaioIgnoreProvider({ globalIgnorePath: null });
      const rules = await provider(dir, []);

      expect(rules.isDenied(path.join(dir, '.env'))).toBe(true);
      expect(rules.isDenied(path.join(dir, 'README.md'))).toBe(false);
    });
  });
});
