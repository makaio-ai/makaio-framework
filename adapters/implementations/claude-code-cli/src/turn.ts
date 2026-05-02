/**
 * Re-export the shared ClaudeConnectorTurn for the claude-code-cli adapter.
 *
 * The CLI adapter uses the same turn state machine as the SDK adapter.
 * The `IQueryInterruptable` seam allows the CLI's process-level interrupt
 * to satisfy the interface without an SDK dependency.
 */
export { ClaudeConnectorTurn } from '@makaio/ai-adapters-claude-shared';
export type { ClaudeTurnState, IQueryInterruptable } from '@makaio/client-claude-code';
