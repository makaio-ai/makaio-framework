/**
 * Shared probes and linter driver of the process-start guard tests.
 *
 * A host config that mounts the guard from an outer root is tested from a test file
 * of its own on purpose: `typescript-eslint` registers every config file's directory
 * as a candidate `tsconfigRootDir` for the whole process, so loading two configs in
 * one process makes the parser refuse to guess one.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

/** The rule ID the guard reports under. */
export const RULE_ID = 'process-start/no-direct-process-start';

/** The framework directory, which is also the root its own config is written for. */
export const frameworkRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export const SPAWN_PROBE = ["import { spawn } from 'node:child_process';", 'export const probe = spawn;'].join('\n');
export const TYPE_PROBE = [
  "import type { ChildProcess } from 'node:child_process';",
  'export type Probe = ChildProcess;',
].join('\n');
export const PRIMITIVE_PROBE = [
  "import { dispatchAgentRehydrate } from './rehydrate-dispatch.js';",
  'export const probe = dispatchAgentRehydrate;',
].join('\n');

/** Probes that start a process, by the way they reach it. */
export const START_PROBES: ReadonlyArray<readonly [string, string]> = [
  ['static import', SPAWN_PROBE],
  ['dynamic import', "export const probe = () => import('node:child_process');"],
  ['require', "export const probe = require('node:child_process');"],
  ['Bun.spawn', "export const probe = () => Bun.spawn(['true']);"],
];

/**
 * Lint one probe as if it were a file at the given path.
 * @param cwd - Directory ESLint runs in; its `eslint.config.mjs` is the config under test.
 * @param source - Probe source to lint.
 * @param relativePath - Path the probe is linted as, from `cwd`.
 * @returns The rule IDs that reported on it.
 */
export async function lintProbe(cwd: string, source: string, relativePath: string): Promise<Array<string | null>> {
  const eslint = new ESLint({ cwd, overrideConfigFile: resolve(cwd, 'eslint.config.mjs'), warnIgnored: false });
  const [result] = await eslint.lintText(source, { filePath: resolve(cwd, relativePath) });
  return result?.messages.map((message) => message.ruleId) ?? [];
}
