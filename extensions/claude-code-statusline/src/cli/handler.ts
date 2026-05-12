import { spawn } from 'node:child_process';
import { text as readStreamText } from 'node:stream/consumers';
import type { IMakaioBus } from '@makaio/bus-core';
import type { ClaudeCodeStatuslineRawPayload } from '@makaio/client-claude-code';
import { ClaudeCodeStatuslineRawPayloadSchema } from '@makaio/client-claude-code';
import { ClaudeCodeClientSubjects } from '@makaio/client-claude-code/runtime';
import type { CommandContext } from '@makaio/kernel/cli';

export interface ClaudeStatuslineArgs {
  readonly upstreamCommand?: string;
  readonly upstreamArgsJson?: string;
}

export interface ClaudeStatuslineCommandContext {
  readonly args: ClaudeStatuslineArgs;
  readonly bus: Pick<IMakaioBus, 'emit'> | null;
  readonly output: Pick<CommandContext<ClaudeStatuslineArgs>['output'], 'write' | 'error'>;
  readonly signal?: AbortSignal;
  readonly setExitCode: CommandContext<ClaudeStatuslineArgs>['setExitCode'];
}

export interface UpstreamCommandRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdinText: string;
  readonly signal: AbortSignal;
  readonly onStdout: (text: string) => void;
  readonly onStderr: (text: string) => void;
}

export interface ClaudeStatuslineCommandDependencies {
  readonly readStdinText: () => Promise<string>;
  readonly runUpstream: (request: UpstreamCommandRequest) => Promise<void>;
}

const neverAbortSignal = new AbortController().signal;

const defaultDependencies: ClaudeStatuslineCommandDependencies = {
  readStdinText: readProcessStdinText,
  runUpstream: runSpawnedUpstream,
};

/**
 * CLI entry handler for `makaio claude statusline`.
 *
 * The command stays silent on its own stdout/stderr so an upstream renderer
 * can own the final statusline text.
 * @param ctx - CLI command context.
 */
export async function handleClaudeStatusline(ctx: CommandContext<ClaudeStatuslineArgs>): Promise<void> {
  await runClaudeStatuslineCommand(ctx, defaultDependencies);
}

/**
 * Execute the raw Claude statusline command.
 * @param ctx - Narrow command context used by both production and tests.
 * @param deps - Injectable side effects for stdin and upstream execution.
 * @returns A promise that always resolves after best-effort ingest and proxying.
 */
export async function runClaudeStatuslineCommand(
  ctx: ClaudeStatuslineCommandContext,
  deps: ClaudeStatuslineCommandDependencies = defaultDependencies,
): Promise<void> {
  const stdinText = await safeReadStdinText(deps);
  const payload = parseRawStatuslinePayload(stdinText);
  const pendingEmit = payload ? safeEmitRawPayload(ctx.bus, payload) : Promise.resolve();

  if (ctx.args.upstreamCommand) {
    await safeRunUpstream(deps, {
      command: ctx.args.upstreamCommand,
      args: parseUpstreamArgs(ctx.args.upstreamArgsJson),
      stdinText,
      signal: ctx.signal ?? neverAbortSignal,
      onStdout: (text) => {
        ctx.output.write(text);
      },
      onStderr: (text) => {
        ctx.output.error(text);
      },
    });
  }

  await pendingEmit;
}

/**
 * Read stdin without allowing read failures to break the command.
 * @param deps - Command-side dependency bundle.
 * @returns The full stdin text, or an empty string when reading fails.
 */
async function safeReadStdinText(deps: ClaudeStatuslineCommandDependencies): Promise<string> {
  try {
    return await deps.readStdinText();
  } catch {
    return '';
  }
}

/**
 * Parse a raw Claude statusline JSON payload from stdin text.
 * @param stdinText - Full stdin text captured for the command invocation.
 * @returns The parsed object payload when stdin contains valid JSON, otherwise `undefined`.
 */
function parseRawStatuslinePayload(stdinText: string): ClaudeCodeStatuslineRawPayload | undefined {
  const trimmed = stdinText.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const result = ClaudeCodeStatuslineRawPayloadSchema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Emit the raw statusline payload on the Claude Code client subject.
 * @param bus - Bus facade used by the command context, or `null` when the bus is unavailable.
 * @param payload - Parsed raw Claude statusline payload.
 * @returns Promise that resolves after the best-effort emit settles.
 */
async function safeEmitRawPayload(
  bus: Pick<IMakaioBus, 'emit'> | null,
  payload: ClaudeCodeStatuslineRawPayload,
): Promise<void> {
  if (!bus) {
    return;
  }
  try {
    await bus.emit(ClaudeCodeClientSubjects.statusline.received, payload);
  } catch {
    // Fail open: statusline rendering should continue even when the bus is unavailable.
  }
}

/**
 * Parse an optional JSON array of upstream command arguments.
 * @param rawArgsJson - User-supplied JSON string from `--upstream-args-json`.
 * @returns A string array suitable for `spawn()`, or an empty array on invalid input.
 */
function parseUpstreamArgs(rawArgsJson: string | undefined): string[] {
  if (!rawArgsJson) {
    return [];
  }

  try {
    const parsed = JSON.parse(rawArgsJson) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((value): value is string => typeof value === 'string');
  } catch {
    return [];
  }
}

/**
 * Run the optional upstream renderer without surfacing failures to the caller.
 * @param deps - Command-side dependency bundle.
 * @param request - Upstream execution request including stdin and output sinks.
 * @returns A promise that resolves after the best-effort upstream attempt.
 */
async function safeRunUpstream(
  deps: ClaudeStatuslineCommandDependencies,
  request: UpstreamCommandRequest,
): Promise<void> {
  try {
    await deps.runUpstream(request);
  } catch {
    // Fail open: if the upstream renderer fails, avoid breaking the statusline hook.
  }
}

/**
 * Read the current process stdin as text.
 * @param stdin - Readable stdin stream to consume.
 * @returns The full stdin text, or an empty string when stdin is interactive.
 */
async function readProcessStdinText(stdin: NodeJS.ReadStream = process.stdin): Promise<string> {
  if (stdin.isTTY === true) {
    return '';
  }

  return readStreamText(stdin);
}

/**
 * Spawn the optional upstream renderer and proxy the original stdin text into it.
 * @param request - Upstream command execution details and output sinks.
 * @returns A promise that resolves once the child process closes.
 */
async function runSpawnedUpstream(request: UpstreamCommandRequest): Promise<void> {
  const child = spawn(request.command, [...request.args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    signal: request.signal,
    windowsHide: true,
  });

  child.stdin.on('error', () => {
    // Ignore EPIPE-style errors so the command remains fail-open.
  });

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string | Buffer) => {
    request.onStdout(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  });

  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string | Buffer) => {
    request.onStderr(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  });

  if (request.stdinText.length > 0) {
    child.stdin.write(request.stdinText);
  }
  child.stdin.end();

  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', () => {
      resolve();
    });
  });
}
