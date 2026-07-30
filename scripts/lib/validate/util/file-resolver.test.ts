/**
 * Contract tests for validation file resolution.
 *
 * The critical invariant: agent-session worktrees under `.claude/worktrees`
 * are full nested checkouts and must never enter the validated file set —
 * even when .gitignore does not cover them (a .gitignore typo once caused
 * every validation run to traverse entire nested checkouts).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveFiles } from './file-resolver.js';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'file-resolver-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, '.claude', 'worktrees', 'session-a', 'src'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(root, 'src', 'real.ts'), 'export const real = 1;\n');
  writeFileSync(join(root, '.claude', 'worktrees', 'session-a', 'src', 'nested.ts'), 'export const nested = 1;\n');
  writeFileSync(join(root, 'node_modules', 'pkg', 'index.ts'), 'export const dep = 1;\n');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('resolveFiles hard ignores', () => {
  it('excludes nested worktree checkouts when expanding directory arguments', async () => {
    const files = await resolveFiles({ files: [root] });

    expect(files).toContain(join(root, 'src', 'real.ts'));
    expect(files.some((file) => file.includes('.claude/worktrees'))).toBe(false);
    expect(files.some((file) => file.includes('node_modules'))).toBe(false);
  });

  it('excludes a nested worktree checkout named as an explicit argument', async () => {
    // The two surrounding cases start from `root`, where globby's default
    // `dot: false` already stops traversal at `.claude` — so they would still
    // pass with the hard ignore removed. Naming the nested checkout directly
    // produces a pattern whose dot segment is explicit, which globby does
    // match; only HARD_IGNORE_PATTERNS keeps the result empty.
    const files = await resolveFiles({ files: [join(root, '.claude', 'worktrees')] });

    expect(files).toEqual([]);
  });

  it('excludes nested worktree checkouts in glob mode without relying on .gitignore', async () => {
    const files = await resolveFiles({ glob: join(root, '**/*.ts') });

    expect(files).toContain(join(root, 'src', 'real.ts'));
    expect(files.some((file) => file.includes('.claude/worktrees'))).toBe(false);
    expect(files.some((file) => file.includes('node_modules'))).toBe(false);
  });
});
