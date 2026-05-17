/**
 * Pure process utilities shared between Claude Code adapter implementations.
 *
 * Provides system prompt building, environment variable resolution, and
 * reasoning level parsing for Claude CLI and tmux adapter implementations.
 * This package has no bus dependencies so it can be used by any adapter
 * that needs to spawn or communicate with a Claude process.
 * @packageDocumentation
 */
export { buildSystemPrompt } from './build-system-prompt.js';
export type { ProviderSystemPrompt } from './build-system-prompt.js';
export { parseReasoningLevel } from './parse-reasoning-level.js';
export {
  CLAUDE_API_KEY_ENV,
  CLAUDE_BASE_URL_ENV,
  readClaudeProviderBaseUrl,
  resolveClaudeProcessEnv,
} from './resolve-claude-process-env.js';
export type { ResolveClaudeProcessEnvOptions } from './resolve-claude-process-env.js';
export { buildTextPrompt, extractMessageText } from './text-prompt.js';
