/**
 * Re-export the shared ClaudeConnectorTurn for the claude-code adapter.
 *
 * The shared turn is parameterized with IQueryInterruptable instead of the
 * SDK's Query type directly, decoupling the turn state machine from the SDK
 * dependency. The ClaudeSdkConnector's Query satisfies IQueryInterruptable
 * since it exposes the interrupt() method.
 */
export { ClaudeConnectorTurn } from '@makaio/ai-adapters-claude-shared';
export type { ClaudeTurnState, IQueryInterruptable } from '@makaio/client-claude-code';
