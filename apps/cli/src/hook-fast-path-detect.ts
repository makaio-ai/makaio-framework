/**
 * Argv detection for the light hook path.
 *
 * **Zero imports, on purpose:** this module is the first thing the CLI entry
 * loads for every invocation, so it must cost nothing — no workspace packages
 * and no node built-ins. It recognises only exactly-known shapes of
 * `makaio [--no-launch] [--debounce-failure] hook received|handle …`; anything
 * else returns `null` so the caller falls through to the full Commander path,
 * which stays the single owner of help, errors, `--config`, and every shape
 * this parser does not explicitly support.
 * @packageDocumentation
 */

/** A hook invocation the light path is able to run on its own. */
export interface LightHookInvocation {
  /** `received` (fire-and-forget) or `handle` (request/response). */
  readonly command: 'received' | 'handle';
  /** Client identifier positional. */
  readonly client: string;
  /** Hook event name positional. */
  readonly eventName: string;
  /** Raw `--metadata-json` value, when given. */
  readonly metadataJson?: string;
  /** `--timeout` in ms (positive integer); `handle` only. */
  readonly timeout?: number;
  /** `--fail-close`; always `false` for `received`. */
  readonly failClose: boolean;
  /** Root flag `--no-launch`. */
  readonly noLaunch: boolean;
  /** Root flag `--debounce-failure`. */
  readonly debounceFailure: boolean;
}

/** Strict positive decimal integer; rejects signs, exponents, decimals, and leading zeros. */
const POSITIVE_INTEGER = /^[1-9]\d*$/;

/**
 * Parse process argv into a light hook invocation.
 *
 * Accepts root flags `--no-launch` and `--debounce-failure` (any order, each at
 * most once) before `hook`, then `received|handle <client> <event-name>` and
 * the options `--metadata-json <json>` (both commands) and `--timeout <ms>` /
 * `--fail-close` (`handle` only), each at most once, in any order. Values are
 * only accepted as a separate argv entry that does not start with `-`;
 * `--flag=value` spellings, help flags, `--config`, `--no-failure`, unknown
 * flags, missing or extra positionals, and an invalid `--timeout` all yield
 * `null`. When in doubt the answer is `null`.
 * @param argv - Raw process argv (`argv[0]` runtime, `argv[1]` script).
 * @returns The invocation, or `null` when the full CLI path must handle argv.
 */
export function parseLightHookInvocation(argv: readonly string[]): LightHookInvocation | null {
  let index = 2;
  let noLaunch = false;
  let debounceFailure = false;

  for (; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--no-launch' && !noLaunch) {
      noLaunch = true;
    } else if (arg === '--debounce-failure' && !debounceFailure) {
      debounceFailure = true;
    } else {
      break;
    }
  }

  if (argv[index] !== 'hook') return null;
  const command = argv[index + 1];
  if (command !== 'received' && command !== 'handle') return null;

  const client = argv[index + 2];
  const eventName = argv[index + 3];
  if (!isOperand(client) || !isOperand(eventName)) return null;

  const options = parseOptions(argv, index + 4, command);
  if (options === null) return null;

  return { command, client, eventName, ...options, noLaunch, debounceFailure };
}

/** Option values shared by both commands, as parsed from the argv tail. */
interface ParsedOptions {
  readonly metadataJson?: string;
  readonly timeout?: number;
  readonly failClose: boolean;
}

/**
 * Parse the option tail after the two positionals.
 * @param argv - Raw process argv.
 * @param start - Index of the first option entry.
 * @param command - Selected hook command; `--timeout` and `--fail-close` are `handle` only.
 * @returns The options, or `null` for anything unknown, repeated, or malformed.
 */
function parseOptions(argv: readonly string[], start: number, command: 'received' | 'handle'): ParsedOptions | null {
  let metadataJson: string | undefined;
  let timeout: number | undefined;
  let failClose = false;

  for (let i = start; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--metadata-json' && metadataJson === undefined) {
      const value = argv[i + 1];
      if (!isOperand(value)) return null;
      metadataJson = value;
      i += 1;
    } else if (command === 'handle' && arg === '--timeout' && timeout === undefined) {
      const value = argv[i + 1];
      if (value === undefined || !POSITIVE_INTEGER.test(value)) return null;
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed)) return null;
      timeout = parsed;
      i += 1;
    } else if (command === 'handle' && arg === '--fail-close' && !failClose) {
      failClose = true;
    } else {
      return null;
    }
  }

  return { metadataJson, timeout, failClose };
}

/**
 * Detect a light hook invocation and run it via the lazily loaded runner.
 *
 * The loader is passed by each entry so bundlers see a literal `import()`
 * specifier. `runLightHookInvocation` never rejects by contract (it reports
 * unexpected errors in the runner's fail-open shape), so only the loader is
 * guarded here.
 * @param argv - Raw process argv.
 * @param loadRunner - Lazy loader for the light runner module.
 * @returns `true` when the hook was fully handled; `false` means: run the full CLI (not a light shape, bus unreachable, or the light module failed to load).
 */
export async function tryLightHookPath(
  argv: readonly string[],
  loadRunner: () => Promise<{
    runLightHookInvocation: (invocation: LightHookInvocation) => Promise<'handled' | 'fallback'>;
  }>,
): Promise<boolean> {
  const invocation = parseLightHookInvocation(argv);
  if (invocation === null) return false;
  let runner: Awaited<ReturnType<typeof loadRunner>>;
  try {
    runner = await loadRunner();
  } catch {
    // Module failed to load: stdin is untouched, so the full path can take over.
    return false;
  }
  return (await runner.runLightHookInvocation(invocation)) === 'handled';
}

/**
 * Whether an argv entry is a usable positional or option value.
 * @param value - Argv entry, possibly absent.
 * @returns `true` for a non-empty string that does not look like a flag.
 */
function isOperand(value: string | undefined): value is string {
  return value !== undefined && value.length > 0 && !value.startsWith('-');
}
