import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createMakaioContext } from '@makaio/core';
import { FILE_ACCESS_RULES_KEY, type FileAccessRules } from '../../types.js';
import { listDirectoryTool } from '../list-directory.js';
import { useTempDir } from './test-helpers.js';

const createTempDir = useTempDir('list-directory-ignore-');

/**
 * Build a MakaioContext with a custom isDenied predicate injected as FileAccessRules.
 * @param tmpDir - Temp directory used as cwd
 * @param isDenied - Predicate that returns true for paths that should be filtered
 */
function buildContext(
  tmpDir: string,
  isDenied: (absolutePath: string) => boolean,
): ReturnType<typeof createMakaioContext> {
  const rules: FileAccessRules = {
    isDenied,
  };
  return createMakaioContext({
    cwd: tmpDir,
    constraints: { [FILE_ACCESS_RULES_KEY]: rules },
  });
}

describe('list_directory .makaioignore filtering', () => {
  describe('non-recursive listing', () => {
    it('ignored file does not appear but non-ignored file does', async () => {
      const tmpDir = await createTempDir();
      await fs.writeFile(path.join(tmpDir, 'secret.env'), 'SECRET=123');
      await fs.writeFile(path.join(tmpDir, 'readme.txt'), 'Hello');

      const context = buildContext(tmpDir, (p) => path.basename(p) === 'secret.env');
      const result = await listDirectoryTool.execute({ path: tmpDir }, context);

      expect(result.success).toBe(true);
      if (result.success) {
        const names = result.data.entries.map((e) => e.name);
        expect(names).not.toContain('secret.env');
        expect(names).toContain('readme.txt');
      }
    });

    it('non-ignored files all appear when only one file is denied', async () => {
      const tmpDir = await createTempDir();
      await fs.writeFile(path.join(tmpDir, 'a.txt'), 'a');
      await fs.writeFile(path.join(tmpDir, 'b.txt'), 'b');
      await fs.writeFile(path.join(tmpDir, 'c.txt'), 'c');
      await fs.writeFile(path.join(tmpDir, 'private.key'), 'key');

      const context = buildContext(tmpDir, (p) => path.basename(p) === 'private.key');
      const result = await listDirectoryTool.execute({ path: tmpDir }, context);

      expect(result.success).toBe(true);
      if (result.success) {
        const names = result.data.entries.map((e) => e.name);
        expect(names).not.toContain('private.key');
        expect(names).toContain('a.txt');
        expect(names).toContain('b.txt');
        expect(names).toContain('c.txt');
        expect(result.data.totalCount).toBe(3);
      }
    });

    it('returns all entries when isDenied always returns false', async () => {
      const tmpDir = await createTempDir();
      await fs.writeFile(path.join(tmpDir, 'alpha.txt'), '');
      await fs.writeFile(path.join(tmpDir, 'beta.txt'), '');

      const context = buildContext(tmpDir, () => false);
      const result = await listDirectoryTool.execute({ path: tmpDir }, context);

      expect(result.success).toBe(true);
      if (result.success) {
        const names = result.data.entries.map((e) => e.name);
        expect(names).toContain('alpha.txt');
        expect(names).toContain('beta.txt');
        expect(result.data.totalCount).toBe(2);
      }
    });
  });

  describe('recursive listing', () => {
    it('denied directory and its contents are both pruned from recursive results', async () => {
      const tmpDir = await createTempDir();
      const sshDir = path.join(tmpDir, '.ssh');
      await fs.mkdir(sshDir);
      await fs.writeFile(path.join(sshDir, 'id_rsa'), 'private-key-data');
      await fs.writeFile(path.join(tmpDir, 'readme.txt'), 'public');

      // Deny both the .ssh directory itself and any path containing /.ssh/
      const context = buildContext(tmpDir, (p) => {
        const rel = path.relative(tmpDir, p);
        return rel === '.ssh' || rel.startsWith('.ssh' + path.sep);
      });

      const result = await listDirectoryTool.execute({ path: tmpDir, recursive: true, includeHidden: true }, context);

      expect(result.success).toBe(true);
      if (result.success) {
        const names = result.data.entries.map((e) => e.name);
        expect(names).not.toContain('.ssh');
        expect(names).not.toContain('id_rsa');
        expect(names).toContain('readme.txt');
      }
    });

    it('non-denied subdirectory and its files appear in recursive results', async () => {
      const tmpDir = await createTempDir();
      const subDir = path.join(tmpDir, 'src');
      await fs.mkdir(subDir);
      await fs.writeFile(path.join(subDir, 'index.ts'), '');
      await fs.writeFile(path.join(tmpDir, 'package.json'), '{}');
      // Use a non-hidden filename so the assertion tests isDenied filtering,
      // not the hidden-file filter (which would mask the real behaviour).
      await fs.writeFile(path.join(tmpDir, 'secrets.env'), 'SECRET=1');

      // Only deny secrets.env
      const context = buildContext(tmpDir, (p) => path.basename(p) === 'secrets.env');

      const result = await listDirectoryTool.execute({ path: tmpDir, recursive: true }, context);

      expect(result.success).toBe(true);
      if (result.success) {
        const names = result.data.entries.map((e) => e.name);
        expect(names).not.toContain('secrets.env');
        expect(names).toContain('src');
        expect(names).toContain('index.ts');
        expect(names).toContain('package.json');
      }
    });

    it('file allowed by negated isDenied (returns false) appears in listing', async () => {
      const tmpDir = await createTempDir();
      const notesDir = path.join(tmpDir, 'notes');
      await fs.mkdir(notesDir);
      await fs.writeFile(path.join(notesDir, 'important.log'), 'keep this');
      await fs.writeFile(path.join(notesDir, 'debug.log'), 'skip this');

      // This intentionally tests the isDenied predicate in isolation.
      // End-to-end .makaioignore `!` negation semantics are covered in
      // makaioignore-provider.test.ts.
      // Deny all .log files EXCEPT important.log (predicate-level negation scenario)
      const context = buildContext(tmpDir, (p) => p.endsWith('.log') && path.basename(p) !== 'important.log');

      const result = await listDirectoryTool.execute({ path: tmpDir, recursive: true }, context);

      expect(result.success).toBe(true);
      if (result.success) {
        const names = result.data.entries.map((e) => e.name);
        expect(names).toContain('important.log');
        expect(names).not.toContain('debug.log');
      }
    });
  });
});
