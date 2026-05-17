import type { RequiredTimeoutConfig } from '@makaio/utils';

/** Stable adapter identifier used for bus namespace, config keys, and extension manifest. */
export const ADAPTER_NAME = 'claude-code-tmux';

/** Human-readable name shown in the adapter picker UI. */
export const ADAPTER_DISPLAY_NAME = 'Claude Code (tmux)';

/** tmux server name — all adapter sessions run on `-L makaio` for isolation. */
export const TMUX_SERVER_NAME = 'makaio';

/** Milliseconds to wait for the SessionStart hook after spawning Claude Code. */
export const DEFAULT_SESSION_START_TIMEOUT_MS = 30_000;

/** Milliseconds to wait for a hook event during a turn before considering it timed out. */
export const DEFAULT_HOOK_EVENT_TIMEOUT_MS = 60_000;

/** Milliseconds to let Claude Code restore the composer after ESC before replacement input. */
export const DEFAULT_INTERRUPT_SETTLE_MS = 2_000;

/**
 * Claude Code's interactive prompt indicator rendered in the composer area.
 *
 * These strings represent Claude Code's interactive UI elements and may need
 * updating if the Claude Code UI changes.
 */
export const CLAUDE_PROMPT_INDICATOR = '❯';

/**
 * Text present in Claude Code's status bar when the composer is active.
 *
 * These strings represent Claude Code's interactive UI elements and may need
 * updating if the Claude Code UI changes.
 */
export const CLAUDE_STATUS_TOKEN_MARKER = 'tokens';

/** Default timeout configuration for the adapter. */
export const DEFAULT_TIMEOUTS = {
  initialization: DEFAULT_SESSION_START_TIMEOUT_MS,
  acknowledgement: DEFAULT_SESSION_START_TIMEOUT_MS,
  completion: DEFAULT_HOOK_EVENT_TIMEOUT_MS,
  toolApproval: 30_000,
  eventWait: 10_000,
} satisfies RequiredTimeoutConfig;
