import type { RequiredTimeoutConfig } from '@makaio/utils';

/** Adapter name constant for consistent identification */
export const ClaudeCodeAdapterName = 'claude-code';

/** Default timeout configuration for Claude Code adapter */
export const DEFAULT_TIMEOUTS = {
  initialization: 30_000,
  acknowledgement: 30_000,
  completion: 60_000,
  toolApproval: 5_000,
  eventWait: 10_000,
} satisfies RequiredTimeoutConfig;

/**
 * Name of Claude Code's synthetic structured-output tool. The CLI implements the SDK
 * `outputFormat: { type: 'json_schema' }` option as a tool with this name that the model
 * must call once at the end of its turn; the CLI appends it after the `tools` filter, so
 * it is always offered, but PreToolUse hooks and `canUseTool` still see its calls
 * (verified in the bundled CLI of `@anthropic-ai/claude-agent-sdk` 0.2.131).
 */
export const STRUCTURED_OUTPUT_TOOL_NAME = 'StructuredOutput';
