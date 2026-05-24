/**
 * Git hook coverage status reader.
 *
 * Answers `GitHookCoverageResponse` queries by reading the install state file
 * and verifying each wrapper's hash and executable bit. Used by the extension's
 * `IGitHookEventsProvider` implementation to respond to bus coverage queries.
 * @packageDocumentation
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { GitHookCoveredOperation, GitHookCoverageResponse } from '@makaio/contracts';
import { GIT_HOOK_NAMES, GitHookInstallStateSchema, STATE_FILE_NAME, type GitHookName } from './hook-state.js';
import { sha256 } from './hash.js';
import { assertGitHookStateMatchesTargets, resolveGitHookTargets } from './hook-targets.js';

/**
 * Read the install state file from the currently active hooks directory.
 * @param hookDir - Current hook directory resolved through Git plumbing.
 * @returns The raw UTF-8 text of the state file.
 */
async function readStateFile(hookDir: string): Promise<string> {
  return fs.readFile(path.join(hookDir, STATE_FILE_NAME), 'utf8');
}

/**
 * Maps native hook names to the Git operations they cover.
 *
 * Only hooks that produce canonical git events are advertised as operation
 * coverage. `post-merge` and `post-rewrite` emit native hook metadata because
 * Git does not provide enough state to populate the canonical merge/rebase
 * event schemas honestly.
 */
const HOOK_TO_OPERATION: Record<GitHookName, GitHookCoveredOperation | undefined> = {
  'post-commit': 'commit',
  'post-checkout': 'checkout',
  'post-merge': undefined,
  'post-rewrite': undefined,
};

/**
 * Read the native hook installation coverage for a repository.
 *
 * Verifies each installed wrapper's hash and executable bit. Returns
 * `covered: false` with a reason code when any verification step fails so
 * callers can give precise diagnostic messages.
 * @param repoPath - Repository root path.
 * @returns Coverage response indicating which operations are covered by native hooks.
 */
export async function readGitHookStatus(repoPath: string): Promise<GitHookCoverageResponse> {
  let targets;
  try {
    targets = await resolveGitHookTargets(repoPath);
  } catch {
    return { covered: false, reason: 'state-missing', coveredOperations: [] };
  }

  let stateText: string;
  try {
    stateText = await readStateFile(targets.hookDir);
  } catch {
    return { covered: false, reason: 'state-missing', coveredOperations: [] };
  }

  let state;
  try {
    state = GitHookInstallStateSchema.parse(JSON.parse(stateText));
  } catch {
    return { covered: false, reason: 'state-mismatch', coveredOperations: [] };
  }

  try {
    assertGitHookStateMatchesTargets(state, targets);
  } catch {
    return { covered: false, reason: 'state-mismatch', coveredOperations: [] };
  }

  const coveredOperations: GitHookCoveredOperation[] = [];
  for (const hookName of GIT_HOOK_NAMES) {
    const entry = state.hooks[hookName];
    if (!entry) continue;
    try {
      // Check executable bit first: a non-executable hook short-circuits before
      // the more expensive file read and SHA-256 computation.
      const stat = await fs.stat(entry.hookPath);
      if ((stat.mode & 0o111) === 0) continue;
      const content = await fs.readFile(entry.hookPath, 'utf8');
      if (sha256(content) !== entry.wrapperHash) continue;
      const op = HOOK_TO_OPERATION[hookName];
      if (op) coveredOperations.push(op);
    } catch {
      continue;
    }
  }

  if (coveredOperations.length === 0) {
    return { covered: false, reason: 'hook-missing', coveredOperations: [] };
  }

  return { covered: true, reason: 'covered', coveredOperations };
}
