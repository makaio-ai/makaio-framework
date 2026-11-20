/**
 * The `no-direct-process-start` rule, run on real sources through ESLint's `Linter`
 * with the TypeScript parser the repository lints with.
 */
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import rule from '../eslint-rules/no-direct-process-start.js';

/**
 * Lint a source with only this rule enabled.
 * @param source - Source text.
 * @returns The reported messages, as the text each names.
 */
function lint(source: string): string[] {
  const linter = new Linter();
  const messages = linter.verify(
    source,
    [
      {
        files: ['**/*.ts'],
        languageOptions: { parser: tseslint.parser },
        plugins: { guard: { rules: { 'no-direct-process-start': rule } } },
        rules: { 'guard/no-direct-process-start': 'error' },
      },
    ],
    'probe.ts',
  );
  return messages.map((message) => message.message);
}

describe('no-direct-process-start', () => {
  it.each([
    ["import { spawn } from 'node:child_process';"],
    ["import { spawn } from 'child_process';"],
    ["import { execa } from 'execa';"],
    ["import * as pty from 'node-pty';"],
    ["import 'node:child_process';"],
    ["import { type A, spawn } from 'node:child_process';"],
    ["export { spawn } from 'node:child_process';"],
    ["export * from 'node:child_process';"],
    ["const load = () => import('node:child_process');"],
    ['const load = () => import(`node:child_process`);'],
    ["const cp = require('node:child_process');"],
    ["import { createRequire } from 'node:module';\nconst cp = createRequire(import.meta.url)('child_process');"],
    [
      "import { createRequire } from 'node:module';\nconst req = createRequire(import.meta.url);\nconst cp = req('execa');",
    ],
    ["const cp = process.getBuiltinModule('node:child_process');"],
    ['const p = Bun.spawn(["true"]);'],
    ['const p = Bun.spawnSync(["true"]);'],
    ['const p = globalThis.Bun.spawn(["true"]);'],
    ["const p = Bun['spawn'](['true']);"],
    ['const out = await Bun.$`echo hi`;'],
  ])('flags %s', (source) => {
    expect(lint(source)).toHaveLength(1);
  });

  it('names the module in the message', () => {
    expect(lint("import { spawn } from 'node:child_process';")[0]).toContain('"node:child_process"');
  });

  it.each([
    ["import type { ChildProcess } from 'node:child_process';"],
    ["import { type ChildProcess } from 'node:child_process';"],
    ["export type { ChildProcess } from 'node:child_process';"],
    ["import { readFile } from 'node:fs';"],
    ["import('./local.js');"],
    ["const fs = require('node:fs');"],
    ["const name = 'node:child_process';\nconst load = () => import(name);"],
    ['const file = Bun.file("x");'],
    ['const x = other.spawn("true");'],
    ["const req = (id: string) => id;\nreq('execa');"],
  ])('allows %s', (source) => {
    expect(lint(source)).toEqual([]);
  });
});
