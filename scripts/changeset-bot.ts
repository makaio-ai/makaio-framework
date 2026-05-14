#!/usr/bin/env tsx
/**
 * Changeset bot — manages changelog configuration comments on PRs.
 *
 * Two modes of operation, both designed to be called from a GitHub Actions
 * workflow triggered by `issue_comment` events:
 *
 * **post-config** — Post (or replace) the changelog configuration comment.
 * Fetches the CodeRabbit walkthrough from the PR, extracts file paths and
 * summary, maps paths to publishable packages, and posts the interactive
 * checkbox comment.
 *
 * **generate** — Parse the config comment on a PR and commit a changeset file.
 * Finds the config comment, extracts bump types and summary, writes the
 * `.changeset/*.md` file, commits it, and resets the Generate checkbox.
 *
 * Both modes support `--dry-run` which prints the output to stdout without
 * touching GitHub or git.
 * @example
 * ```bash
 * # Dry-run: preview what the config comment would look like
 * tsx scripts/changeset-bot.ts post-config --pr 889 --repo makaio-ai/makaio --dry-run
 *
 * # Post config comment:
 * tsx scripts/changeset-bot.ts post-config --pr 889 --repo makaio-ai/makaio
 *
 * # Generate changeset:
 * tsx scripts/changeset-bot.ts generate --pr 889 --repo makaio-ai/makaio
 *
 * # Generate changeset into a separate PR checkout while running trusted script code:
 * tsx scripts/changeset-bot.ts generate --pr 889 --repo makaio-ai/makaio --target-root ../pr-checkout
 * ```
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Octokit } from '@octokit/rest';
import { resolveGithubToken } from './lib/github-auth.js';
import { resolveFrameworkPrefix } from './lib/changeset-bot/resolve-framework-prefix.js';
import { parseCodeRabbitChanges } from './lib/changeset-bot/parse-coderabbit-summary.js';
import { groupChangesByPackage } from './lib/changeset-bot/group-changes-by-package.js';
import {
  renderConfigComment,
  parseConfigComment,
  isConfigComment,
  resetGenerateCheckbox,
} from './lib/changeset-bot/config-comment.js';
import { generateChangesetContent, generateChangesetFilename } from './lib/changeset-bot/generate-changeset-content.js';

interface PostConfigOptions {
  mode: 'post-config';
  pr: number;
  owner: string;
  repo: string;
  dryRun: boolean;
}

interface GenerateOptions {
  mode: 'generate';
  pr: number;
  owner: string;
  repo: string;
  commentId: number | null;
  targetRoot: string;
  dryRun: boolean;
}

type CliOptions = PostConfigOptions | GenerateOptions;

interface RawFlags {
  mode: 'post-config' | 'generate';
  flags: ReadonlyMap<string, string>;
  dryRun: boolean;
}

/**
 * Extracts the mode, key-value flags, and boolean flags from argv.
 * @param argv - Process arguments (after stripping node + script path).
 * @returns Structured raw flags.
 */
function extractFlags(argv: string[]): RawFlags {
  const mode = argv[0];
  if (mode !== 'post-config' && mode !== 'generate') {
    throw new Error(
      'Usage: changeset-bot <post-config|generate> --pr <number> --repo <owner/repo> [--comment-id <id>] [--target-root <path>] [--dry-run]',
    );
  }
  const flagArgs = argv.slice(1);
  const dryRun = flagArgs.includes('--dry-run');
  const flags = new Map<string, string>();
  for (let i = 0; i < flagArgs.length; i++) {
    if (flagArgs[i] === '--dry-run') continue;
    if (flagArgs[i].startsWith('--') && i + 1 < flagArgs.length) {
      flags.set(flagArgs[i].slice(2), flagArgs[i + 1]);
      i++;
    }
  }
  return { mode, flags, dryRun };
}

/**
 * Parses and validates a `owner/repo` slug from a flag value.
 * @param raw - The raw flag value, or `undefined`.
 * @returns Tuple of `[owner, repo]`.
 */
function parseRepoSlug(raw: string | undefined): [string, string] {
  if (!raw) throw new Error('--repo is required (owner/repo)');
  if (!raw.includes('/')) throw new Error('--repo must be owner/repo');
  const [owner, repo] = raw.split('/');
  return [owner, repo];
}

/**
 * Parses CLI arguments into structured options.
 * @param argv - Process arguments (after stripping node + script path).
 * @returns Parsed options.
 */
function parseArgs(argv: string[]): CliOptions {
  const { mode, flags, dryRun } = extractFlags(argv);

  const pr = Number(flags.get('pr'));
  if (!pr || !Number.isInteger(pr)) throw new Error('--pr is required (integer)');

  const [owner, repo] = parseRepoSlug(flags.get('repo'));

  if (mode === 'generate') {
    const rawCommentId = flags.get('comment-id');
    const commentId = rawCommentId ? Number(rawCommentId) : null;
    if (rawCommentId && (!commentId || !Number.isInteger(commentId))) {
      throw new Error('--comment-id must be an integer');
    }
    const targetRoot = resolve(flags.get('target-root') ?? process.cwd());
    return { mode, pr, owner, repo, commentId, targetRoot, dryRun };
  }

  return { mode, pr, owner, repo, dryRun };
}

type IssueComment = Awaited<ReturnType<Octokit['issues']['listComments']>>['data'][number];

/**
 * Fetches all comments on a PR via pagination.
 * @param octokit - Authenticated client.
 * @param owner - Repository owner.
 * @param repo - Repository name.
 * @param pr - Pull request number.
 * @returns All comments on the PR.
 */
async function fetchPrComments(octokit: Octokit, owner: string, repo: string, pr: number): Promise<IssueComment[]> {
  return octokit.paginate(octokit.issues.listComments, {
    owner,
    repo,
    issue_number: pr,
    per_page: 100,
  });
}

/**
 * Posts (or replaces) the changelog configuration comment on a PR.
 * @param octokit - Authenticated client.
 * @param opts - CLI options.
 */
async function postConfig(octokit: Octokit, opts: PostConfigOptions): Promise<void> {
  const comments = await fetchPrComments(octokit, opts.owner, opts.repo, opts.pr);

  const coderabbit = comments.find(
    (c) => c.user?.login === 'coderabbitai[bot]' && c.body?.includes('walkthrough_start'),
  );
  if (!coderabbit?.body) {
    console.info('No CodeRabbit walkthrough found — nothing to do.');
    return;
  }

  const rows = parseCodeRabbitChanges(coderabbit.body);
  if (rows.length === 0) {
    console.info('No changes found in CodeRabbit walkthrough — nothing to do.');
    return;
  }

  const prefix = resolveFrameworkPrefix(import.meta.dirname);
  const packages = groupChangesByPackage(rows, prefix);
  if (packages.length === 0) {
    console.info('No publishable packages affected — nothing to do.');
    return;
  }

  const body = renderConfigComment(opts.pr, packages);

  if (opts.dryRun) {
    process.stdout.write(body + '\n');
    return;
  }

  for (const comment of comments) {
    if (comment.body && isConfigComment(comment.body)) {
      await octokit.issues.deleteComment({ owner: opts.owner, repo: opts.repo, comment_id: comment.id });
    }
  }

  await octokit.issues.createComment({
    owner: opts.owner,
    repo: opts.repo,
    issue_number: opts.pr,
    body,
  });
  console.info(`Posted changelog config for ${packages.length} packages on PR #${opts.pr}.`);
}

/**
 * Finds or fetches the config comment, generates a changeset file,
 * commits it, and resets the Generate checkbox.
 * @param octokit - Authenticated client.
 * @param opts - CLI options.
 */
async function generate(octokit: Octokit, opts: GenerateOptions): Promise<void> {
  let commentId: number;
  let commentBody: string;

  if (opts.commentId !== null) {
    const { data: comment } = await octokit.issues.getComment({
      owner: opts.owner,
      repo: opts.repo,
      comment_id: opts.commentId,
    });
    if (!comment.body) throw new Error('Comment body is empty.');
    commentId = comment.id;
    commentBody = comment.body;
  } else {
    const comments = await fetchPrComments(octokit, opts.owner, opts.repo, opts.pr);
    const found = comments.find((c) => c.body && isConfigComment(c.body));
    if (!found?.body) throw new Error(`No changeset config comment found on PR #${opts.pr}.`);
    commentId = found.id;
    commentBody = found.body;
  }

  const state = parseConfigComment(commentBody);
  if (!state) throw new Error('Comment is not a changeset config comment.');

  if (!state.generateRequested) {
    console.info('Generate not requested — nothing to do.');
    return;
  }

  if (state.packages.length === 0) {
    throw new Error('No packages found in config comment.');
  }

  const content = generateChangesetContent(state.packages);
  const filename = generateChangesetFilename();

  if (opts.dryRun) {
    console.info(`Would generate: .changeset/${filename}`);
    process.stdout.write(content);
    return;
  }

  const changesetDir = resolve(opts.targetRoot, '.changeset');
  mkdirSync(changesetDir, { recursive: true });

  const filePath = join(changesetDir, filename);
  writeFileSync(filePath, content, 'utf-8');
  console.info(`Generated changeset: .changeset/${filename}`);

  execFileSync('git', ['add', filePath], { cwd: opts.targetRoot, stdio: 'inherit' });
  execFileSync('git', ['commit', '-m', `chore: add changeset for PR #${opts.pr}`], {
    cwd: opts.targetRoot,
    stdio: 'inherit',
  });
  execFileSync('git', ['push'], { cwd: opts.targetRoot, stdio: 'inherit' });
  console.info('Committed and pushed changeset.');

  await octokit.issues.updateComment({
    owner: opts.owner,
    repo: opts.repo,
    comment_id: commentId,
    body: resetGenerateCheckbox(commentBody),
  });
  console.info('Reset Generate checkbox.');
}

if (import.meta.filename === process.argv[1]) {
  const opts = parseArgs(process.argv.slice(2));
  const octokit = new Octokit({ auth: resolveGithubToken() });

  const run = opts.mode === 'post-config' ? postConfig(octokit, opts) : generate(octokit, opts);
  run.catch((error: unknown) => {
    const message =
      error instanceof Error ? (process.env.DEBUG ? (error.stack ?? error.message) : error.message) : String(error);
    console.error(message);
    process.exit(1);
  });
}
