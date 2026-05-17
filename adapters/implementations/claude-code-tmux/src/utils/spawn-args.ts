import type { SystemPrompt } from '@makaio/contracts';

/** Launch-time options for the long-lived Claude Code tmux process. */
export interface ClaudeCodeTmuxSpawnArgsOptions {
  /** Claude Code session ID passed through `--session-id` for hook correlation. */
  sessionId: string;
  /** Model identifier passed to Claude Code. */
  model: string;
  /** Optional system prompt to pass at process startup. */
  systemPrompt?: SystemPrompt;
  /** Whether to pass `--dangerously-skip-permissions`; defaults to `true`. */
  skipPermissions?: boolean;
}

/**
 * Build Claude Code launch arguments for the long-lived tmux process.
 * @param options - Session identity and launch-time model/prompt options.
 *   `skipPermissions` defaults to `true`: tool approval is handled by the
 *   Makaio harness via MCP, so `--dangerously-skip-permissions` is added
 *   unless explicitly set to `false`.
 * @returns CLI arguments passed to the Claude binary.
 */
export function buildSpawnArgs(options: ClaudeCodeTmuxSpawnArgsOptions): string[] {
  const args = ['--verbose'];

  if (options.skipPermissions !== false) {
    args.push('--dangerously-skip-permissions');
  }

  args.push('--session-id', options.sessionId, '--model', options.model);

  if (typeof options.systemPrompt === 'string') {
    args.push('--system-prompt', options.systemPrompt);
  } else if (options.systemPrompt) {
    args.push('--append-system-prompt', options.systemPrompt.content);
  }

  return args;
}
