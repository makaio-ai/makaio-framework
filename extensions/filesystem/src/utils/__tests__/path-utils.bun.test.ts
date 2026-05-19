import { describe, expect, it } from 'bun:test';
import { createMakaioContext } from '@makaio/core';
import { FILE_ACCESS_RULES_KEY, type FileAccessRules } from '../../types.js';
import { validatePath } from '../path-utils.js';

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

  it('returns { valid: false } for a path outside allowedDirectories', () => {
    const rules: FileAccessRules = {
      allowedDirectories: ['/allowed/dir'],
      isDenied: () => false,
    };
    const context = createMakaioContext({
      cwd: '/test',
      constraints: { [FILE_ACCESS_RULES_KEY]: rules },
    });

    const result = validatePath('/outside/dir/file.txt', context);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('outside allowed directories');
    }
  });

  it('denies a path that is inside allowedDirectories but matched by isDenied', () => {
    const rules: FileAccessRules = {
      allowedDirectories: ['/allowed/dir'],
      isDenied: (p) => p.endsWith('.secret'),
    };
    const context = createMakaioContext({
      cwd: '/test',
      constraints: { [FILE_ACCESS_RULES_KEY]: rules },
    });

    // Path is inside the allowed directory but matched by the deny predicate
    const result = validatePath('/allowed/dir/credentials.secret', context);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('.makaioignore');
    }
  });

  it('allows a path inside allowedDirectories when isDenied does not match', () => {
    const rules: FileAccessRules = {
      allowedDirectories: ['/allowed/dir'],
      isDenied: () => false,
    };
    const context = createMakaioContext({
      cwd: '/test',
      constraints: { [FILE_ACCESS_RULES_KEY]: rules },
    });

    const result = validatePath('/allowed/dir/credentials.txt', context);

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

  it('uses legacy allowedDirectories from constraints when no FileAccessRules present', () => {
    const context = createMakaioContext({
      cwd: '/test',
      constraints: {
        allowedDirectories: ['/allowed/dir'],
      },
    });

    // Path inside allowed dir should pass
    const allowed = validatePath('/allowed/dir/file.txt', context);
    expect(allowed.valid).toBe(true);

    // Path outside allowed dir should fail
    const denied = validatePath('/outside/file.txt', context);
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
});
