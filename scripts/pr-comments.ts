#!/usr/bin/env tsx
/**
 * Fetch actionable GitHub PR review feedback.
 *
 * This script merges:
 * - inline review comments from review threads
 * - PR-level review bodies from review summaries
 *
 * It intentionally excludes common noise by default.
 * It can also persist seen entry IDs for deterministic polling.
 * @example
 * ```bash
 * # Default: actionable inline comments plus actionable PR review bodies
 * tsx scripts/pr-comments.ts https://github.com/makaio-ai/makaio/pull/86
 *
 * # Only feedback from the last 10 minutes
 * tsx scripts/pr-comments.ts --since 10 https://github.com/makaio-ai/makaio/pull/86
 *
 * # Only print entries not seen in the local state file, then record them as seen
 * tsx scripts/pr-comments.ts --new https://github.com/makaio-ai/makaio/pull/86
 *
 * # Poll every 30 seconds for up to 20 minutes until new actionable entries appear
 * tsx scripts/pr-comments.ts --new --timeout 20 https://github.com/makaio-ai/makaio/pull/86
 *
 * # Use a custom state file
 * tsx scripts/pr-comments.ts --new --state-file .tmp/my-pr-comment-state.json https://github.com/makaio-ai/makaio/pull/86
 *
 * # Include resolved thread comments
 * tsx scripts/pr-comments.ts --resolved https://github.com/makaio-ai/makaio/pull/86
 *
 * # Include outdated thread comments
 * tsx scripts/pr-comments.ts --outdated https://github.com/makaio-ai/makaio/pull/86
 *
 * # Keep review walkthrough and auto-generated markup instead of stripping it
 * tsx scripts/pr-comments.ts --raw https://github.com/makaio-ai/makaio/pull/86
 *
 * # Stream new findings continuously (implies --new, runs until SIGTERM)
 * tsx scripts/pr-comments.ts --watch https://github.com/makaio-ai/makaio/pull/86
 * ```
 */

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Octokit } from '@octokit/rest';
import {
  filterNewEntries,
  loadReviewState,
  recordSeenEntries,
  saveReviewState,
  type ReviewStateFile,
} from './lib/pr-comment-state.js';
import { parseCliOptions } from './lib/pr-comment-options.js';
import {
  isActionableFileComment,
  isActionableIssueComment,
  isActionableReviewBody,
  normalizeReviewBody,
} from './lib/pr-comment-filters.js';
import { renderReviewEntries, renderWatchBatchHeader, renderWorkflowReminder } from './lib/pr-comment-output.js';
import { fetchCiCheckEntries, type CiCheckEntry } from './lib/pr-comment-ci.js';
import type {
  PrCoordinates,
  CommentEntry,
  FileCommentEntry,
  IssueCommentEntry,
  ReviewBodyEntry,
  ReviewEntry,
} from './lib/pr-comment-types.js';
import { fetchReviewEntries, getGhToken, parsePrUrl, pullRequestStateKey } from './lib/pr-comment-fetch.js';

/** Polling cadence for timed `--new` checks. */
const POLL_INTERVAL_MS = 30_000;

interface ResolvedVisibleEntries {
  readonly entries: ReviewEntry[];
  readonly markRendered: () => Promise<void>;
}

/**
 * Resolve the GitHub token used by Octokit.
 *
 * Environment variables are preferred because CI already exposes tokens this
 * way; falling back to `gh auth token` keeps local interactive usage intact.
 * @param env - Environment map to inspect
 * @param fallback - Token resolver used when no environment token is present
 * @returns GitHub auth token
 */
export function resolveGithubAuthToken(
  env: NodeJS.ProcessEnv = process.env,
  fallback: () => string = getGhToken,
): string {
  const envToken = env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim();
  return envToken || fallback();
}

/**
 * Pause between timed polling attempts.
 * @param milliseconds - Delay duration
 * @returns Promise resolved after the delay
 */
function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  });
}

/**
 * Fetch, normalize, and optionally time-filter actionable review entries.
 * @param octokit - Authenticated Octokit instance
 * @param coords - Pull request coordinates
 * @param options - CLI options controlling filtering behavior
 * @returns Actionable review entries for the current poll
 */
async function collectActionableEntries(
  octokit: Octokit,
  coords: PrCoordinates,
  options: ReturnType<typeof parseCliOptions>,
): Promise<ReviewEntry[]> {
  const reviewEntries = await fetchReviewEntries(octokit, coords, {
    includeResolved: options.includeResolved,
    includeOutdated: options.includeOutdated,
  });

  let ciEntries: CiCheckEntry[];
  try {
    ciEntries = await fetchCiCheckEntries(octokit, coords);
  } catch (error) {
    console.warn(
      `Warning: failed to fetch CI check results: ${error instanceof Error ? error.message : String(error)}`,
    );
    ciEntries = [];
  }

  let comments: CommentEntry[] = reviewEntries;
  let filteredCiEntries: CiCheckEntry[] = ciEntries;

  if (options.sinceMinutes !== null) {
    const cutoff = new Date(Date.now() - options.sinceMinutes * 60_000);
    comments = comments.filter((entry) => new Date(entry.createdAt) >= cutoff);
    filteredCiEntries = filteredCiEntries.filter((entry) => new Date(entry.createdAt) >= cutoff);
  }

  if (!options.raw) {
    comments = comments
      .map<CommentEntry>((entry) => ({
        ...entry,
        body: normalizeReviewBody(entry.body),
      }))
      .filter((entry) => {
        switch (entry.kind) {
          case 'file':
            return isActionableFileComment(entry.body);
          case 'review':
            return isActionableReviewBody(entry.body);
          case 'comment':
            return isActionableIssueComment(entry.body);
        }
      });
  }

  return [...comments, ...filteredCiEntries];
}

/**
 * Resolve the currently visible entries for this run, optionally polling until new ones appear.
 * @param octokit - Authenticated Octokit instance
 * @param coords - Pull request coordinates
 * @param options - CLI options controlling polling and state behavior
 * @returns Visible entries for this run
 */
async function resolveVisibleEntries(
  octokit: Octokit,
  coords: PrCoordinates,
  options: ReturnType<typeof parseCliOptions>,
): Promise<ResolvedVisibleEntries> {
  const state = options.onlyNew ? await loadReviewState(options.stateFilePath) : null;
  const prKey = pullRequestStateKey(coords);
  const deadline = options.timeoutMinutes === null ? null : Date.now() + options.timeoutMinutes * 60_000;

  while (true) {
    const entries = await collectActionableEntries(octokit, coords, options);
    const visibleEntries = options.onlyNew && state ? filterNewEntries(entries, state, prKey) : entries;

    if (visibleEntries.length > 0 || deadline === null || Date.now() >= deadline) {
      return {
        entries: visibleEntries,
        markRendered: async () => {
          if (options.onlyNew && state) {
            recordSeenEntries(entries, state, prKey);
            await saveReviewState(options.stateFilePath, state);
          }
        },
      };
    }

    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
  }
}

/**
 * Record entries as seen after their output has been emitted successfully.
 * @param entries - Entries to mark as seen
 * @param state - Mutable persistent review state
 * @param prKey - Stable PR state key
 * @param stateFilePath - State file path to persist
 */
async function markRenderedEntries(
  entries: ReviewEntry[],
  state: ReviewStateFile,
  prKey: string,
  stateFilePath: string,
): Promise<void> {
  recordSeenEntries(entries, state, prKey);
  await saveReviewState(stateFilePath, state);
}

/**
 * Split entries by kind and delegate to the standard renderer.
 * @param entries - Mixed review entries to render
 */
function renderEntries(entries: ReviewEntry[]): void {
  renderReviewEntries(
    entries.filter((e): e is ReviewBodyEntry => e.kind === 'review'),
    entries.filter((e): e is FileCommentEntry => e.kind === 'file'),
    entries.filter((e): e is IssueCommentEntry => e.kind === 'comment'),
    entries.filter((e): e is CiCheckEntry => e.kind === 'ci'),
  );
}

/**
 * Stream new findings continuously until the process receives SIGTERM.
 *
 * Each poll cycle checks for unseen entries using the same state file
 * mechanism as `--new`. When new entries appear, a timestamped batch
 * header is printed followed by the standard rendered output.
 * @param octokit - Authenticated Octokit instance
 * @param coords - Pull request coordinates
 * @param options - CLI options
 */
async function runWatchMode(
  octokit: Octokit,
  coords: PrCoordinates,
  options: ReturnType<typeof parseCliOptions>,
): Promise<void> {
  const state = await loadReviewState(options.stateFilePath);
  const prKey = pullRequestStateKey(coords);

  console.info(
    `Watching PR ${options.url} for new findings (poll every ${POLL_INTERVAL_MS / 1000}s, SIGTERM to stop)…`,
  );

  while (true) {
    const entries = await collectActionableEntries(octokit, coords, options);
    const newEntries = filterNewEntries(entries, state, prKey);

    if (newEntries.length > 0) {
      renderWatchBatchHeader(newEntries.length);
      renderEntries(newEntries);
      await markRenderedEntries(entries, state, prKey, options.stateFilePath);
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * Script entry point for fetching and printing PR review comments.
 */
async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const coords = parsePrUrl(options.url);
  const octokit = new Octokit({ auth: resolveGithubAuthToken() });

  if (options.watch) {
    await runWatchMode(octokit, coords, options);
    return;
  }

  const visibleEntries = await resolveVisibleEntries(octokit, coords, options);

  if (visibleEntries.entries.length === 0) {
    console.info(
      options.onlyNew ? 'No new actionable PR review feedback found.' : 'No actionable PR review feedback found.',
    );
    renderWorkflowReminder(
      {
        onlyNew: options.onlyNew,
        timedPoll: options.timeoutMinutes !== null,
      },
      false,
    );
    return;
  }

  renderEntries(visibleEntries.entries);
  renderWorkflowReminder(
    {
      onlyNew: options.onlyNew,
      timedPoll: options.timeoutMinutes !== null,
    },
    true,
  );
  await visibleEntries.markRendered();
}

/**
 * Determine whether this module is the executed CLI entrypoint.
 *
 * The monorepo exposes this framework-owned script through a symlink, so both
 * sides of the comparison must be resolved to real paths before comparing.
 * @param argvPath - Script path from `process.argv[1]`.
 * @returns `true` when the current module is the CLI entrypoint.
 */
function isEntrypoint(argvPath: string | undefined): boolean {
  return argvPath !== undefined && realpathSync(resolve(argvPath)) === realpathSync(fileURLToPath(import.meta.url));
}

const isMain = isEntrypoint(process.argv[1]);

if (isMain) {
  main().catch((error: Error) => {
    console.error(error.message);
    process.exit(1);
  });
}
