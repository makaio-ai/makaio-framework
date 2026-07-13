import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMakaioContext } from '@makaio/core';
import { FILE_ACCESS_RULES_KEY, type FileAccessRules } from '../../types.js';
import { createPathValidator, validatePath } from '../path-utils.js';
import { useTempDir } from '../../tools/__tests__/test-helpers.js';

const createTempDir = useTempDir('path-utils-');

describe('validatePath', () => {
  it('returns { valid: false } for a path denied by FileAccessRules', () => {
    const rules: FileAccessRules = {
      isDenied: (p) => p.endsWith('.env'),
    };
    const context = createMakaioContext({
      cwd: '/test',
      constraints: { [FILE_ACCESS_RULES_KEY]: rules },
    });

    const result = validatePath('/test/project/.env', context);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('.makaioignore');
    }
  });

  it('returns { valid: true } for a path allowed by FileAccessRules', () => {
    const rules: FileAccessRules = {
      isDenied: (p) => p.endsWith('.env'),
    };
    const context = createMakaioContext({
      cwd: '/test',
      constraints: { [FILE_ACCESS_RULES_KEY]: rules },
    });

    const result = validatePath('/test/project/README.md', context);

    expect(result.valid).toBe(true);
  });

  it('returns { valid: false } for a path outside allowedDirectories', async () => {
    const tempDir = await createTempDir();
    const allowedDir = path.join(tempDir, 'allowed');
    const outsidePath = path.join(tempDir, 'outside.txt');
    await fs.mkdir(allowedDir);
    await fs.writeFile(outsidePath, 'outside');
    const rules: FileAccessRules = {
      allowedDirectories: [allowedDir],
      isDenied: () => false,
    };
    const context = createMakaioContext({
      cwd: tempDir,
      constraints: { [FILE_ACCESS_RULES_KEY]: rules },
    });

    const result = validatePath(outsidePath, context);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('outside allowed directories');
    }
  });

  it('denies a path that is inside allowedDirectories but matched by isDenied', async () => {
    const tempDir = await createTempDir();
    const allowedDir = path.join(tempDir, 'allowed');
    const secretPath = path.join(allowedDir, 'credentials.secret');
    await fs.mkdir(allowedDir);
    await fs.writeFile(secretPath, 'secret');
    const rules: FileAccessRules = {
      allowedDirectories: [allowedDir],
      isDenied: (p) => p.endsWith('.secret'),
    };
    const context = createMakaioContext({
      cwd: tempDir,
      constraints: { [FILE_ACCESS_RULES_KEY]: rules },
    });

    // Path is inside the allowed directory but matched by the deny predicate
    const result = validatePath(secretPath, context);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('.makaioignore');
    }
  });

  it('allows a path inside allowedDirectories when isDenied does not match', async () => {
    const tempDir = await createTempDir();
    const allowedDir = path.join(tempDir, 'allowed');
    const allowedPath = path.join(allowedDir, 'credentials.txt');
    await fs.mkdir(allowedDir);
    await fs.writeFile(allowedPath, 'allowed');
    const rules: FileAccessRules = {
      allowedDirectories: [allowedDir],
      isDenied: () => false,
    };
    const context = createMakaioContext({
      cwd: tempDir,
      constraints: { [FILE_ACCESS_RULES_KEY]: rules },
    });

    const result = validatePath(allowedPath, context);

    expect(result.valid).toBe(true);
  });

  it('is backward compatible when no FileAccessRules are present in constraints', () => {
    const context = createMakaioContext({
      cwd: '/test',
      // No FILE_ACCESS_RULES_KEY in constraints
      constraints: {},
    });

    const result = validatePath('/any/path/file.txt', context);

    expect(result.valid).toBe(true);
  });

  it('is backward compatible when constraints are absent entirely', () => {
    const context = createMakaioContext({
      cwd: '/test',
    });

    const result = validatePath('/any/path/file.txt', context);

    expect(result.valid).toBe(true);
  });

  it('uses legacy allowedDirectories from constraints when no FileAccessRules present', async () => {
    const tempDir = await createTempDir();
    const allowedDir = path.join(tempDir, 'allowed');
    const allowedPath = path.join(allowedDir, 'file.txt');
    const outsidePath = path.join(tempDir, 'outside.txt');
    await fs.mkdir(allowedDir);
    await fs.writeFile(allowedPath, 'allowed');
    await fs.writeFile(outsidePath, 'outside');
    const context = createMakaioContext({
      cwd: tempDir,
      constraints: {
        allowedDirectories: [allowedDir],
      },
    });

    // Path inside allowed dir should pass
    const allowed = validatePath(allowedPath, context);
    expect(allowed.valid).toBe(true);

    // Path outside allowed dir should fail
    const denied = validatePath(outsidePath, context);
    expect(denied.valid).toBe(false);
  });

  it('treats empty allowedDirectories as deny-all', () => {
    const rules: FileAccessRules = {
      allowedDirectories: [],
      isDenied: () => false,
    };
    const context = createMakaioContext({
      cwd: '/test',
      constraints: { [FILE_ACCESS_RULES_KEY]: rules },
    });

    const result = validatePath('/test/project/file.txt', context);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('outside allowed directories');
    }
  });

  it('ignores malformed fileAccessRules payloads instead of throwing', () => {
    const context = createMakaioContext({
      cwd: '/test',
      constraints: {
        [FILE_ACCESS_RULES_KEY]: { allowedDirectories: ['/allowed'] },
      },
    });

    const result = validatePath('/test/project/file.txt', context);

    expect(result.valid).toBe(true);
  });

  it('ignores malformed allowedDirectories when isDenied is present', () => {
    const context = createMakaioContext({
      cwd: '/test',
      constraints: {
        [FILE_ACCESS_RULES_KEY]: {
          allowedDirectories: 123,
          isDenied: () => false,
        },
      },
    });

    const result = validatePath('/test/project/file.txt', context);

    expect(result.valid).toBe(true);
  });

  it('rejects lexical paths outside the canonical allowed root', async () => {
    const tempDir = await createTempDir();
    const allowedDir = path.join(tempDir, 'allowed');
    const outsidePath = path.join(tempDir, 'outside.txt');
    await fs.mkdir(allowedDir);
    await fs.writeFile(outsidePath, 'outside');
    const context = createMakaioContext({
      cwd: tempDir,
      constraints: { [FILE_ACCESS_RULES_KEY]: { allowedDirectories: [allowedDir], isDenied: () => false } },
    });

    expect(validatePath(outsidePath, context).valid).toBe(false);
  });

  it('rejects a directory symlink that resolves outside the canonical allowed root', async () => {
    const tempDir = await createTempDir();
    const allowedDir = path.join(tempDir, 'allowed');
    const outsideDir = path.join(tempDir, 'outside');
    const escapedPath = path.join(allowedDir, 'outside-link', 'secret.txt');
    await fs.mkdir(allowedDir);
    await fs.mkdir(outsideDir);
    await fs.writeFile(path.join(outsideDir, 'secret.txt'), 'outside secret');
    await fs.symlink(outsideDir, path.join(allowedDir, 'outside-link'));
    const context = createMakaioContext({
      cwd: allowedDir,
      constraints: { [FILE_ACCESS_RULES_KEY]: { allowedDirectories: [allowedDir], isDenied: () => false } },
    });

    expect(validatePath(escapedPath, context).valid).toBe(false);
  });

  it('rejects a file symlink that resolves outside the canonical allowed root', async () => {
    const tempDir = await createTempDir();
    const allowedDir = path.join(tempDir, 'allowed');
    const outsidePath = path.join(tempDir, 'outside.txt');
    const escapedPath = path.join(allowedDir, 'outside-link.txt');
    await fs.mkdir(allowedDir);
    await fs.writeFile(outsidePath, 'outside secret');
    await fs.symlink(outsidePath, escapedPath);
    const context = createMakaioContext({
      cwd: allowedDir,
      constraints: { [FILE_ACCESS_RULES_KEY]: { allowedDirectories: [allowedDir], isDenied: () => false } },
    });

    expect(validatePath(escapedPath, context).valid).toBe(false);
  });

  it('denies a symlink alias when its canonical target is ignored', async () => {
    const tempDir = await createTempDir();
    const targetPath = path.join(tempDir, 'secret.txt');
    const aliasPath = path.join(tempDir, 'visible-link.txt');
    await fs.writeFile(targetPath, 'secret');
    await fs.symlink(targetPath, aliasPath);
    const canonicalTarget = await fs.realpath(targetPath);
    const context = createMakaioContext({
      cwd: tempDir,
      constraints: { [FILE_ACCESS_RULES_KEY]: { isDenied: (candidate: string) => candidate === canonicalTarget } },
    });

    expect(validatePath(aliasPath, context).valid).toBe(false);
  });

  it('denies an ignored lexical alias when its canonical target is allowed', async () => {
    const tempDir = await createTempDir();
    const targetPath = path.join(tempDir, 'visible.txt');
    const aliasPath = path.join(tempDir, 'secret-link.txt');
    await fs.writeFile(targetPath, 'visible');
    await fs.symlink(targetPath, aliasPath);
    const context = createMakaioContext({
      cwd: tempDir,
      constraints: { [FILE_ACCESS_RULES_KEY]: { isDenied: (candidate: string) => candidate === aliasPath } },
    });

    expect(validatePath(aliasPath, context).valid).toBe(false);
  });

  it('canonicalizes allowed roots once for a compiled validator', async () => {
    const tempDir = await createTempDir();
    const firstRoot = path.join(tempDir, 'first');
    const secondRoot = path.join(tempDir, 'second');
    const rootAlias = path.join(tempDir, 'allowed');
    const firstFile = path.join(firstRoot, 'first.txt');
    const secondFile = path.join(secondRoot, 'second.txt');
    await fs.mkdir(firstRoot);
    await fs.mkdir(secondRoot);
    await fs.writeFile(firstFile, 'first');
    await fs.writeFile(secondFile, 'second');
    await fs.symlink(firstRoot, rootAlias);
    const context = createMakaioContext({
      cwd: tempDir,
      constraints: { [FILE_ACCESS_RULES_KEY]: { allowedDirectories: [rootAlias], isDenied: () => false } },
    });
    const validate = createPathValidator(context);

    await fs.unlink(rootAlias);
    await fs.symlink(secondRoot, rootAlias);

    expect(validate(firstFile).valid).toBe(true);
    expect(validate(secondFile).valid).toBe(false);
    expect(validatePath(secondFile, context).valid).toBe(true);
  });
});
