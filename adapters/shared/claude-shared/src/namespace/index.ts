import {
  SDKUserMessageSchema,
  SDKAssistantMessageSchema,
  SDKResultMessageSchema,
  SDKSystemMessageSchema,
  SDKStreamEventMessageSchema,
  TurnStateChangedEventSchema,
  SDKMessageSchema,
  type SDKMessage,
} from '@makaio/client-claude-code';
import { createAdapterNamespace, ScopedToolApprovalSchema } from '@makaio/ai-adapters-core';
import type { ScopedBusFor } from '@makaio/bus-core';

export type { SDKMessage };
export { SDKMessageSchema };

/**
 * Creates a Claude protocol adapter namespace registered on the bus.
 *
 * Both the claude-code and anthropic-sdk adapters speak the same Claude
 * protocol (same event shapes and subjects) but must register under
 * different namespace names. This factory avoids duplicating the subject
 * definitions across adapters.
 * @param namespaceName - The bus namespace domain (e.g., 'adapter:claude-code')
 * @returns Typed adapter namespace with subjects and scoped bus factory
 * @example
 * ```typescript
 * // In claude-code adapter:
 * const ClaudeCodeConnectorNamespace = createClaudeConnectorNamespace('adapter:claude-code');
 *
 * // In anthropic-sdk adapter:
 * const AnthropicConnectorNamespace = createClaudeConnectorNamespace('adapter:anthropic-sdk');
 * ```
 */
export function createClaudeConnectorNamespace<N extends string>(namespaceName: N) {
  return createAdapterNamespace(namespaceName, {
    // Raw SDK event catch-all (for observability/debugging)
    'sdk.event': SDKMessageSchema,

    // Tool approval RPC — sessionId optional at connector layer; enriched by agent before global forwarding
    can_use_tool: ScopedToolApprovalSchema,

    // Semantic subjects (typed events for agent layer)
    system: SDKSystemMessageSchema,
    assistant: SDKAssistantMessageSchema,
    user: SDKUserMessageSchema,
    result: SDKResultMessageSchema,
    stream_event: SDKStreamEventMessageSchema,

    // Turn state events (for Session/Turn extraction)
    'turn.state_changed': TurnStateChangedEventSchema,
    'turn.turn_started': TurnStateChangedEventSchema,
    'turn.step_started': TurnStateChangedEventSchema,
    'turn.step_finished': TurnStateChangedEventSchema,
    'turn.turn_finished': TurnStateChangedEventSchema,
    'turn.paused': TurnStateChangedEventSchema,
  });
}

/**
 * Type of the namespace returned by {@link createClaudeConnectorNamespace}.
 * @typeParam N - The namespace domain string literal
 */
export type ClaudeConnectorNamespace<N extends string> = ReturnType<typeof createClaudeConnectorNamespace<N>>;

/**
 * Scoped bus type for a Claude connector namespace.
 * @typeParam N - The namespace domain string literal
 */
export type ClaudeConnectorBus<N extends string> = ScopedBusFor<ClaudeConnectorNamespace<N>>;
