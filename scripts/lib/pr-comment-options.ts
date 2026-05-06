import { resolve } from 'node:path';

/** Parsed CLI arguments for the PR comment collector. */
export interface CliOptions {
  /** Preserve raw review bodies instead of stripping noise. */
  raw: boolean;
  /** Include resolved inline threads. */
  includeResolved: boolean;
  /** Include outdated inline threads. */
  includeOutdated: boolean;
  /** Only include entries created within this minute window. */
  sinceMinutes: number | null;
  /** Only print entries not already seen in the state file. */
  onlyNew: boolean;
  /** Maximum time to poll for new entries before returning. */
  timeoutMinutes: number | null;
  /** Stream new findings continuously until SIGTERM. Implies `--new`. */
  watch: boolean;
  /** Path to the persistent state file when using `--new`. */
  stateFilePath: string;
  /** Pull request URL. */
  url: string;
}

/** Default path for persistent PR comment state. */
const DEFAULT_STATE_FILE = '.tmp/pr-comments-state.json';
const VALUE_FLAGS = ['--since', '--timeout', '--state-file'] as const;
const STATE_FILE_FLAG = VALUE_FLAGS[2];

/**
 * Parse a positive numeric CLI option that takes a value.
 * @param args - Raw CLI args
 * @param flag - Option flag to parse
 * @returns Parsed positive number or null when omitted
 */
function parsePositiveNumberOption(args: string[], flag: '--since' | '--timeout'): number | null {
  const optionIndex = args.indexOf(flag);
  if (optionIndex === -1) {
    return null;
  }

  const value = Number(args[optionIndex + 1]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${flag} requires a positive number of minutes.`);
  }

  return value;
}

/**
 * Resolve a value-bearing option path, falling back to the default state file.
 * @param args - Raw CLI args
 * @returns Absolute state-file path
 */
function resolveStateFilePath(args: string[]): string {
  const optionIndex = args.indexOf(STATE_FILE_FLAG);
  if (optionIndex === -1) {
    return resolve(DEFAULT_STATE_FILE);
  }
  if (!args[optionIndex + 1]) {
    throw new Error('--state-file requires a file path.');
  }
  return resolve(args[optionIndex + 1]);
}

/**
 * Find the PR URL argument after removing values consumed by other options.
 * @param args - Raw CLI args
 * @returns Pull request URL
 */
function parsePullRequestUrl(args: string[]): string {
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (VALUE_FLAGS.includes(arg as (typeof VALUE_FLAGS)[number])) {
      index += 1;
      continue;
    }

    if (!arg.startsWith('--')) {
      positionals.push(arg);
    }
  }

  if (positionals.length !== 1) {
    throw new Error(
      'Usage: tsx scripts/pr-comments.ts [--raw] [--resolved] [--outdated] [--since <minutes>] [--new] [--timeout <minutes>] [--watch] [--state-file <path>] <pr-url>',
    );
  }

  return positionals[0];
}

/**
 * Read CLI arguments into a normalized option object.
 * @param args - Raw process arguments after the script name
 * @returns Parsed options
 * @throws If required flags are missing or invalid
 */
export function parseCliOptions(args: string[]): CliOptions {
  const raw = args.includes('--raw');
  const includeResolved = args.includes('--resolved');
  const includeOutdated = args.includes('--outdated');
  const watch = args.includes('--watch');
  const onlyNew = args.includes('--new') || watch;
  const sinceMinutes = parsePositiveNumberOption(args, '--since');
  const timeoutMinutes = parsePositiveNumberOption(args, '--timeout');
  if (timeoutMinutes !== null && !onlyNew) {
    throw new Error('--timeout requires --new because timed polling only makes sense for unseen comments.');
  }
  if (watch && timeoutMinutes !== null) {
    throw new Error('--watch and --timeout are mutually exclusive. Watch mode runs until SIGTERM.');
  }
  const stateFilePath = resolveStateFilePath(args);
  const url = parsePullRequestUrl(args);
  return { raw, includeResolved, includeOutdated, sinceMinutes, onlyNew, timeoutMinutes, watch, stateFilePath, url };
}
