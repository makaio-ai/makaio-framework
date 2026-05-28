/**
 * Core logic for the `makaio prompt send` CLI subcommand.
 *
 * Sends a prompt to any AI provider through the Makaio bus and formats the
 * output via a pluggable {@link OutputFormatter}. The command flow is:
 *
 * 1. Read prompt text from the positional argument or stdin pipe.
 * 2. Generate (or reuse) a session ID.
 * 3. Subscribe to agent events for the session (before sending to prevent races).
 * 4. Optionally persist a session approval-policy override when `--dangerously-skip-permissions` is set.
 * 5. Send the message via `session.sendMessage`.
 * 6. Wait for `session.turn.completed` with a configurable timeout.
 * 7. Flush the formatter, propagate the exit code, clean up subscriptions.
 */
import { z } from 'zod';
import type { WildcardContext } from '@makaio/core';
import { defineCliSubcommand, requireBus, type CommandContext } from '@makaio/kernel/cli';
import { AgentSubjects, SessionStorageSubjects, SessionSubjects } from '@makaio/contracts';
import type { CanonicalModelSelection, SystemPrompt } from '@makaio/contracts';
import { CLI_EXIT_CODES, classifyCliCommandError, readStdin, resolveCliSignalExitCode } from '@makaio/utils';
import { TextFormatter } from './formatters/text.js';
import { JsonFormatter } from './formatters/json.js';
import { StreamJsonFormatter } from './formatters/stream-json.js';
import type { OutputFormat, OutputFormatter, OutputWriter, TurnResult } from './formatters/types.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * CLI parser-compatible tool list.
 *
 * The current CLI schema adapter provides option values as strings. Accepting
 * a string here keeps the Zod schema as the single source of truth while still
 * normalizing quoted space-separated and comma-separated tool lists into the
 * agent-selection contract's `string[]`.
 */
const ToolListSchema = z
  .string()
  .transform((value) =>
    value
      .split(/[,\s]+/)
      .map((toolName) => toolName.trim())
      .filter((toolName) => toolName.length > 0),
  )
  .optional();

/**
 * Zod schema for the `send` subcommand arguments.
 *
 * Every option carries CLI metadata via `.meta()` so the framework can
 * generate `--help` output and parse command-line flags without additional
 * glue code.
 */
export const PromptArgsSchema = z.object({
  prompt: z.string().optional().meta({
    description: 'Prompt text (omit to read from stdin)',
    positional: true,
    placeholder: '[prompt]',
  }),
  model: z.string().optional().meta({
    description: 'Canonical model reference',
    short: '-m',
    placeholder: '<model>',
  }),
  outputFormat: z.enum(['text', 'json', 'stream-json']).optional().default('text').meta({
    description: 'Output format',
    placeholder: '<format>',
  }),
  systemPrompt: z.string().optional().meta({
    description: 'System prompt (replaces default)',
    placeholder: '<prompt>',
  }),
  appendSystemPrompt: z.string().optional().meta({
    description: 'Append to default system prompt',
    placeholder: '<text>',
  }),
  allowedTools: ToolListSchema.meta({
    description: 'Tool allowlist (comma-separated or quoted space-separated)',
    placeholder: '<tools>',
  }),
  disallowedTools: ToolListSchema.meta({
    description: 'Tool denylist (comma-separated or quoted space-separated)',
    placeholder: '<tools>',
  }),
  dangerouslySkipPermissions: z.boolean().optional().meta({
    description: 'Auto-approve all tool calls',
  }),
  reasoningEffort: z.enum(['low', 'medium', 'high']).optional().meta({
    description: 'Reasoning effort level',
    placeholder: '<level>',
  }),
  cwd: z.string().optional().meta({
    description: 'Working directory for the agent',
    placeholder: '<dir>',
  }),
  sessionId: z.string().optional().meta({
    description: 'Reuse specific session ID',
    placeholder: '<uuid>',
  }),
  timeout: z.number().optional().default(300).meta({
    description: 'Overall timeout in seconds',
    placeholder: '<seconds>',
  }),
});

/** Inferred type for validated command arguments. */
export type PromptArgs = z.infer<typeof PromptArgsSchema>;

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

const EXIT_FAILURE = CLI_EXIT_CODES.failure;
const EXIT_TIMEOUT = CLI_EXIT_CODES.timeout;
const EXIT_ABORT = CLI_EXIT_CODES.abort;

// ---------------------------------------------------------------------------
// Formatter factory
// ---------------------------------------------------------------------------

/**
 * Instantiate the appropriate {@link OutputFormatter} for `format`.
 * @param format - Requested output format.
 * @param output - Injectable writer abstraction from the command context.
 * @param sessionId - Session ID for JSON formatters that embed it.
 * @param startTime - Unix timestamp (ms) at command start for JSON formatters.
 * @returns A fresh {@link OutputFormatter} instance.
 */
function createOutputFormatter(
  format: OutputFormat,
  output: OutputWriter,
  sessionId: string,
  startTime: number,
): OutputFormatter {
  switch (format) {
    case 'text':
      return new TextFormatter(output);
    case 'json':
      return new JsonFormatter(output, startTime);
    case 'stream-json':
      return new StreamJsonFormatter(sessionId, startTime, output);
  }
}

// ---------------------------------------------------------------------------
// Subscription helpers
// ---------------------------------------------------------------------------

/**
 * Subscribe to all agent events for a session and forward them to the formatter.
 *
 * Must be called BEFORE sending the message to prevent the race where a turn
 * completes before the subscriber is registered.
 * @param ctx - CLI command context.
 * @param sessionId - Session ID to filter events by.
 * @param formatter - Formatter that accumulates event data.
 * @returns Unsubscribe function.
 */
function subscribeAgentEvents(
  ctx: CommandContext<PromptArgs>,
  sessionId: string,
  formatter: OutputFormatter,
): () => void {
  const bus = requireBus(ctx);
  return bus.on(
    AgentSubjects.$all,
    (busCtx: WildcardContext<unknown, unknown>) => {
      if (!busCtx.isRequest) {
        formatter.handleEvent(busCtx.subject, busCtx.payload);
      }
    },
    { filter: { sessionId } },
  );
}

/**
 * Persist a session-level approval override before the first message is sent.
 *
 * The tool approval service reads `approvalPolicyOverride` from session
 * storage before falling through to interactive approval. Registering a local
 * `agent.toolApprove` handler here would race or lose to the service's
 * middleware ordering, so the CLI writes through the same durable session
 * policy seam used by the rest of the runtime.
 * @param ctx - CLI command context.
 * @param sessionId - Session ID to scope the handler to.
 */
async function enableFullAccessApprovalPolicy(ctx: CommandContext<PromptArgs>, sessionId: string): Promise<void> {
  const bus = requireBus(ctx);
  const { session } = await bus.request(SessionSubjects.get, { sessionId }, { signal: ctx.signal });
  if (session && session.status !== 'active') {
    throw new Error(`Session is not active: ${sessionId}`);
  }

  if (!session) {
    await bus.request(SessionSubjects.create, { sessionId }, { signal: ctx.signal });
  }

  const update = await bus.request(
    SessionStorageSubjects.update,
    {
      sessionId,
      approvalPolicyOverride: 'full-access',
    },
    { signal: ctx.signal },
  );
  if (!update.success) {
    throw new Error(`Failed to set full-access approval policy for session: ${sessionId}`);
  }
}

// ---------------------------------------------------------------------------
// Message dispatch
// ---------------------------------------------------------------------------

/**
 * Resolve the `systemPrompt` field from mutually exclusive CLI flags.
 *
 * `--system-prompt` replaces the default (plain string); `--append-system-prompt`
 * appends to it (structured union). Both absent → `undefined`.
 * @param systemPrompt - Value from `--system-prompt`.
 * @param appendSystemPrompt - Value from `--append-system-prompt`.
 * @returns Typed system prompt value or `undefined`.
 */
function resolveSystemPrompt(
  systemPrompt: string | undefined,
  appendSystemPrompt: string | undefined,
): SystemPrompt | undefined {
  if (systemPrompt !== undefined) return systemPrompt;
  if (appendSystemPrompt !== undefined) return { mode: 'append' as const, content: appendSystemPrompt };
  return undefined;
}

/**
 * Build the required agent-selection fragment from parsed args.
 *
 * When `--model` is omitted, returns `undefined` so the session can reuse
 * its existing agent configuration.
 * @param args - Validated command arguments.
 * @returns Canonical model agent selection, or `undefined` when model is omitted.
 */
function buildAgentSelection(args: PromptArgs): CanonicalModelSelection | undefined {
  if (args.model === undefined) return undefined;

  const systemPrompt = resolveSystemPrompt(args.systemPrompt, args.appendSystemPrompt);

  return {
    kind: 'canonical-model',
    model: args.model,
    ...(systemPrompt !== undefined && { systemPrompt }),
    ...(args.allowedTools !== undefined && { allowedTools: args.allowedTools }),
    ...(args.disallowedTools !== undefined && { disallowedTools: args.disallowedTools }),
    ...(args.reasoningEffort !== undefined && { reasoningEffort: args.reasoningEffort }),
    cwd: args.cwd ?? process.cwd(),
  };
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

/**
 * Execute the `makaio prompt send` command.
 *
 * Implements the full send-and-wait lifecycle: prompt resolution, subscription
 * setup, message dispatch, turn-completion wait, formatter flush, and cleanup.
 *
 * The handler never throws — all errors are surfaced via `ctx.setExitCode()`.
 * Subscriptions are always cleaned up in the `finally` block.
 * @param ctx - Command context provided by the CLI framework.
 */
export async function handlePrompt(ctx: CommandContext<PromptArgs>): Promise<void> {
  const bus = requireBus(ctx);
  const { args, output, signal } = ctx;
  const startTime = Date.now();

  // Subscribe BEFORE sending to prevent turn-completion race.
  const cleanups: Array<() => void> = [];
  try {
    const promptText = await resolvePromptText(args.prompt, output, signal);
    if (promptText === null) {
      ctx.setExitCode(EXIT_FAILURE);
      return;
    }

    const sessionId = args.sessionId ?? crypto.randomUUID();
    const formatter = createOutputFormatter(args.outputFormat, output, sessionId, startTime);

    cleanups.push(subscribeAgentEvents(ctx, sessionId, formatter));
    if (args.dangerouslySkipPermissions === true) {
      await enableFullAccessApprovalPolicy(ctx, sessionId);
    }

    const agent = buildAgentSelection(args);

    const completionPromise = bus.once(SessionSubjects.turn.completed, {
      filter: { sessionId },
      signal,
      timeoutMs: args.timeout * 1000,
    });
    completionPromise.catch(() => undefined);

    await bus.request(
      SessionSubjects.sendMessage,
      {
        sessionId,
        message: promptText,
        source: 'extension',
        extensionId: 'prompt',
        ...(agent !== undefined && { agent }),
      },
      { signal },
    );

    const completionCtx = await completionPromise;

    const turnResult: TurnResult = {
      sessionId: completionCtx.payload.sessionId,
      turnId: completionCtx.payload.turnId,
      turnNumber: completionCtx.payload.turnNumber,
      success: completionCtx.payload.success,
      error: completionCtx.payload.error,
    };

    ctx.setExitCode(formatter.flush(turnResult));
  } catch (err) {
    handleCommandError(resolveCommandError(err, signal), args.timeout, output, signal, ctx.setExitCode.bind(ctx));
  } finally {
    for (const cleanup of cleanups) {
      cleanup();
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the final prompt text from arg or stdin, returning `null` on failure.
 *
 * Writes an error message and returns `null` when no prompt is available.
 * Preserves the original content from stdin, only stripping the trailing
 * newline that shells typically append when piping.
 * @param promptArg - The positional prompt argument value.
 * @param output - Writer to send error messages to.
 * @param signal - Command abort signal that cancels piped stdin reads.
 * @returns Resolved prompt string or `null`.
 */
async function resolvePromptText(
  promptArg: string | undefined,
  output: OutputWriter,
  signal: AbortSignal,
): Promise<string | null> {
  if (promptArg) return promptArg;
  const stdin = await readStdin(signal);
  if (!stdin || stdin.trim() === '') {
    output.error('Error: no prompt provided. Pass a positional argument or pipe text to stdin.\n');
    return null;
  }
  return stdin.replace(/\r?\n$/, '');
}

/**
 * Normalize generic request-abort errors into the stable CLI abort sentinel.
 * @param err - Caught command error.
 * @param signal - Command abort signal.
 * @returns Original error, or an abort-classified error when the command signal fired.
 */
function resolveCommandError(err: unknown, signal: AbortSignal): unknown {
  if (signal.aborted && classifyCliCommandError(err) === 'failure') {
    const abort = new Error(String(signal.reason ?? 'Command aborted'));
    abort.name = 'OnceAbortError';
    return abort;
  }
  return err;
}

/**
 * Map a caught error to the appropriate exit code and write user-facing output.
 *
 * `OnceAbortError` → signal-specific process exit code when available, otherwise 130.
 * Error named `'OnceTimeoutError'` → 124 (GNU timeout convention).
 * All other errors → 1 with the error message written to stderr.
 * @param err - The caught error value.
 * @param timeoutSeconds - Configured timeout in seconds (for the error message).
 * @param output - Writer for error messages.
 * @param signal - Command abort signal whose reason may carry the process signal name.
 * @param setExitCode - Exit-code setter from the command context.
 */
function handleCommandError(
  err: unknown,
  timeoutSeconds: number,
  output: OutputWriter,
  signal: AbortSignal,
  setExitCode: (code: number) => void,
): void {
  switch (classifyCliCommandError(err)) {
    case 'abort':
      setExitCode(resolveCliSignalExitCode(signal.reason) ?? EXIT_ABORT);
      return;
    case 'timeout':
      output.error(`Error: prompt timed out after ${timeoutSeconds}s.\n`);
      setExitCode(EXIT_TIMEOUT);
      return;
    case 'failure':
      output.error(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
      setExitCode(EXIT_FAILURE);
      return;
  }
}

// ---------------------------------------------------------------------------
// Subcommand definition
// ---------------------------------------------------------------------------

export const promptCommand = defineCliSubcommand(
  'send',
  'Send a prompt to any AI provider',
  PromptArgsSchema,
  handlePrompt,
);
