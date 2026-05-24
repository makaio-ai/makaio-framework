/**
 * Core receive logic for the git hook receiver.
 *
 * Collects context from the running Git process, assembles a
 * {@link RawInboundHookPayload}, and emits it on the Makaio bus. All
 * dependencies are injectable so the function is fully testable without a live
 * Git repository or bus connection.
 *
 * Fail-open semantics: the binary exit code must always be 0 so Git does not
 * abort the in-progress operation because the receiver failed.
 * @packageDocumentation
 */

import * as path from 'node:path';
import { emitInboundHookReceivedFast, safeReadStdinText, type RawInboundHookPayload } from '@makaio/inbound-hooks';
import { gitOutputOptional } from '../install/git-command.js';
import type { GitHookReceiverArgs } from './args.js';

// ---------------------------------------------------------------------------
// Injectable dependencies
// ---------------------------------------------------------------------------

/**
 * Side-effects bundle injected into {@link receiveGitHook}.
 *
 * Extracting these makes the function fully testable without spawning real
 * git processes, connecting to a bus, or reading from process stdin.
 */
export interface GitHookReceiverDependencies {
  /**
   * Working directory used for git plumbing queries.
   *
   * Defaults to `process.cwd()` — the directory where the wrapper script ran,
   * which is the repository root for all four managed hooks.
   */
  readonly cwd: string;
  /**
   * Read stdin text; should be fail-open (return `''` on error or TTY).
   * @returns The full stdin text.
   */
  readonly readStdinText: () => Promise<string>;
  /**
   * Emit the raw inbound hook payload on the bus.
   * @param source - Source identifier (always `'git'`).
   * @param payload - The assembled raw inbound hook payload.
   */
  readonly emit: (source: string, payload: RawInboundHookPayload) => Promise<void>;
  /**
   * Return the current Unix epoch milliseconds.
   * @returns Current timestamp in milliseconds.
   */
  readonly now: () => number;
}

const defaultDependencies: GitHookReceiverDependencies = {
  cwd: process.cwd(),
  readStdinText: safeReadStdinText,
  emit: emitInboundHookReceivedFast,
  now: Date.now,
};

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Receive a native git hook event and emit it on the Makaio bus.
 *
 * Queries git plumbing (`rev-parse`) for repository context, reads any stdin
 * data produced by the hook, and emits a {@link RawInboundHookPayload} on
 * `hook:git.received`. All git queries use {@link gitOutputOptional} so a
 * missing or non-git working directory is handled gracefully.
 * @param args - Parsed receiver arguments (event name, state file, hook argv).
 * @param deps - Injectable side-effects; defaults to process-level I/O.
 */
export async function receiveGitHook(
  args: GitHookReceiverArgs,
  deps: GitHookReceiverDependencies = defaultDependencies,
): Promise<void> {
  const stdinText = await deps.readStdinText();
  const repoRoot = await gitOutputOptional(['rev-parse', '--show-toplevel'], deps.cwd);
  const gitDir = await gitOutputOptional(['rev-parse', '--git-dir'], deps.cwd);
  const gitCommonDir = await gitOutputOptional(['rev-parse', '--git-common-dir'], deps.cwd);

  const repoPayload: Record<string, unknown> = {
    repoPath: repoRoot ?? deps.cwd,
    cwd: deps.cwd,
    stateFile: path.resolve(args.stateFile),
    ...(gitDir !== undefined && { gitDir }),
    ...(gitCommonDir !== undefined && { gitCommonDir }),
  };

  await deps.emit('git', {
    eventName: args.eventName,
    receivedAt: deps.now(),
    argv: [...args.argv],
    stdinText,
    payload: repoPayload,
  });
}
