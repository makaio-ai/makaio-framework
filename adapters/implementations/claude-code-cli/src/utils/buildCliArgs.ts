import type { AIReasoningLevel } from '@makaio/ai-adapters-core';
import type { NativeForkDirective } from '@makaio/contracts';
import type { ClaudeCliSessionConfig } from '../types.js';

/**
 * Maps a normalized reasoning level to the value accepted by the `--effort` CLI flag.
 *
 * The CLI accepts `low | medium | high | max`. `'extra-high'` is mapped to `'max'`
 * and `'none'` returns `undefined` so the flag is omitted entirely.
 * @param level - Normalized reasoning level from the shared contract
 * @returns CLI effort string, or `undefined` when the flag should be omitted
 */
function toCliEffortValue(level: AIReasoningLevel): string | undefined {
  if (level === 'none') return undefined;
  if (level === 'extra-high') return 'max';
  return level;
}

/**
 * Serialize Claude CLI tool policy lists into one deterministic flag value.
 * @param tools - Tool names or patterns in caller-provided order
 * @returns Comma-separated CLI flag value
 */
function toCliToolPolicyValue(tools: string[]): string {
  return tools.join(',');
}

/**
 * Assert that the active native fork directive can be represented by Claude Code CLI flags.
 *
 * The CLI exposes tip forks via `--resume <source> --fork-session`, but has no
 * equivalent for the SDK's `resumeSessionAt` mid-history branch point.
 * @param nativeFork - Native fork directive that would be applied to this turn.
 */
export function assertCliNativeForkSupported(nativeFork: NativeForkDirective | undefined): void {
  if (nativeFork?.forkPointMessageId !== undefined) {
    throw new Error('[claude-code-cli] Native mid-history fork is not supported by the CLI adapter');
  }
}

/**
 * Arguments for building CLI arguments.
 */
interface BuildCliArgsOptions {
  /** Session configuration */
  config: ClaudeCliSessionConfig;
  /** The user message to send as prompt */
  prompt: string;
  /** Session ID to use (for reproducibility) */
  sessionId: string;
  /**
   * Inline MCP config JSON string (or path to a JSON file).
   * When set, passes --mcp-config to the claude CLI.
   */
  mcpConfig?: string;
  /**
   * MCP tool name to use as the permission prompt handler.
   * When set, passes --permission-prompt-tool to the claude CLI.
   */
  permissionPromptTool?: string;
}

/**
 * Build the CLI argument array for spawning the `claude` binary.
 *
 * Flags used:
 * - `-p` — non-interactive print mode (required for JSON streaming)
 * - `--output-format stream-json` — emit JSONL to stdout
 * - `--include-partial-messages` — stream partial content blocks
 * - `--verbose` — include system init and result events
 * - `--dangerously-skip-permissions` — auto-approve all tool use (opt-in via providerConfig.skipPermissions)
 * - `--session-id` — pin the session ID for new sessions (mutually exclusive with --resume)
 * - `--resume` — resume a previous session by ID (replaces --session-id for subsequent turns)
 * - `--fork-session` — when combined with `--resume`, branch at the tip of the source session
 *   instead of continuing it (requires a `nativeFork` directive without `forkPointMessageId`)
 * - `--model` — the model to use
 * - `--system-prompt` — optional runtime system prompt (plain string)
 * - `--append-system-prompt` — optional runtime system prompt (append mode)
 * - `--max-budget-usd` — optional spend cap
 * - `--effort` — reasoning effort level (`low | medium | high | max`); omitted when `none`
 * - `--allowedTools` — optional comma-separated allow-list from `config.allowedTools`
 * - `--disallowedTools` — optional comma-separated deny-list from `config.disallowedTools`
 * - `--mcp-config` — optional inline JSON MCP config string (or path to a JSON file)
 * - `--permission-prompt-tool` — optional MCP tool to handle permission prompts
 * - `--json-schema` — JSON-serialized schema from `config.responseSchema`; constrains model output to valid JSON
 * @param options - Arguments for building CLI args
 * @returns Array of CLI arguments to pass to spawn()
 */
export function buildCliArgs({
  config,
  prompt,
  sessionId,
  mcpConfig,
  permissionPromptTool,
}: BuildCliArgsOptions): string[] {
  const args: string[] = ['--print', '--output-format', 'stream-json', '--include-partial-messages', '--verbose'];

  if (config.providerConfig?.skipPermissions === true) {
    args.push('--dangerously-skip-permissions');
  }

  if (config.resumeAdapterSessionId !== undefined) {
    // Resuming the fork child (or any existing session) takes priority over the
    // native fork directive: once the first turn has confirmed a child session ID,
    // subsequent turns resume that child via --resume, not re-fork the source.
    args.push('--resume', config.resumeAdapterSessionId);
  } else if (config.nativeFork !== undefined) {
    // Native fork: the CLI supports tip-only fork via --resume + --fork-session.
    // Defense-in-depth: session.startTurn() already calls assertCliNativeForkSupported
    // before reaching buildCliArgs, but this secondary check guards against future
    // callers that invoke buildCliArgs without the session lifecycle gate.
    assertCliNativeForkSupported(config.nativeFork);
    args.push('--resume', config.nativeFork.sourceAdapterSessionId, '--fork-session');
  } else {
    // For new sessions, pin the session ID so we know it before system.init arrives.
    args.push('--session-id', sessionId);
  }

  if (config.model) {
    args.push('--model', config.model);
  }

  if (config.systemPrompt) {
    if (typeof config.systemPrompt === 'string') {
      args.push('--system-prompt', config.systemPrompt);
    } else if (config.systemPrompt.mode === 'append') {
      args.push('--append-system-prompt', config.systemPrompt.content);
    }
  }

  if (config.providerConfig?.maxBudgetUsd !== undefined) {
    args.push('--max-budget-usd', String(config.providerConfig.maxBudgetUsd));
  }

  if (config.reasoningEffort !== undefined) {
    const effortValue = toCliEffortValue(config.reasoningEffort);
    if (effortValue !== undefined) {
      args.push('--effort', effortValue);
    }
  }

  if (config.allowedTools !== undefined) {
    args.push('--allowedTools', toCliToolPolicyValue(config.allowedTools));
  }

  if (config.disallowedTools !== undefined) {
    args.push('--disallowedTools', toCliToolPolicyValue(config.disallowedTools));
  }

  if (mcpConfig) {
    args.push('--mcp-config', mcpConfig);
  }

  if (permissionPromptTool) {
    args.push('--permission-prompt-tool', permissionPromptTool);
  }

  if (config.responseSchema) {
    args.push('--json-schema', JSON.stringify(config.responseSchema.schema));
  }

  // Prompt is the final positional argument
  args.push(prompt);

  return args;
}
