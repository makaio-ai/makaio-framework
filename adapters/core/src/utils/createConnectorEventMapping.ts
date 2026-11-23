import type { AIAgentConnector } from '../connector/agent-connector.js';
import type { AgentContext, AgentIdentity } from '../agent/types.js';
import type {
  CallContext,
  ExtractSubjectPayload,
  HandlerForSubjectDefinition,
  RequestContext,
  ScopedSubjectDefinition,
  SubjectDefinition,
} from '@makaio/core';
import type { EmitSubject, IMakaioBus, ScopedBus } from '@makaio/bus-core';

// ============================================================================
// Exported Utility Types
// ============================================================================

/**
 * Emit helper passed to handler functions for emitting to global subjects.
 * Automatically enriches payloads with AgentContext.
 */
export type ConnectorEmitFn = <S extends SubjectDefinition>(
  subject: S,
  payload: Omit<ExtractSubjectPayload<S>, keyof AgentContext>,
) => Promise<void>;

/**
 * Handler function signature for connector event mapping.
 * Receives the narrowed payload and an emit helper for further emissions.
 * Can be sync or async — async handlers are awaited.
 */
export type ConnectorEventHandlerFn<TPayload> = (payload: TPayload, emit: ConnectorEmitFn) => void | Promise<void>;

/**
 * Handler value: either a subject definition for passthrough or a handler function.
 */
export type ConnectorEventHandlerValue<TPayload> =
  | (SubjectDefinition & { $meta: { payload: TPayload } })
  | ConnectorEventHandlerFn<TPayload>;

/**
 * Discriminator keys type - extracts string keys from the message type.
 */
export type DiscriminatorKeys<TMessage> = (TMessage extends object ? keyof TMessage : never) & string;

/**
 * Discriminator values type - extracts possible values at the discriminator key.
 */
export type DiscriminatorValues<TMessage, TDiscriminator extends string> = (TMessage extends object
  ? TMessage[TDiscriminator & keyof TMessage]
  : never) &
  string;

/**
 * Narrowed message type - extracts the union member matching a discriminator value.
 */
export type NarrowedMessage<TMessage, TDiscriminator extends string, K extends string> = Extract<
  TMessage,
  { [P in TDiscriminator]: K }
>;

/**
 * Complete handlers record type for connector event mapping.
 */
export type ConnectorEventHandlers<TMessage, TDiscriminator extends string> = {
  [K in DiscriminatorValues<TMessage, TDiscriminator>]?: ConnectorEventHandlerValue<
    NarrowedMessage<TMessage, TDiscriminator, K>
  >;
};

// ============================================================================
// Implementation
// ============================================================================

/**
 * Forward an emit for a handled connector message on behalf of its triggering call.
 *
 * Module-private helper shared by the per-message emit binder and the passthrough
 * branch of {@link createConnectorEventMapping}: both emissions belong to the single
 * connector message handled by one subscription invocation, so both forward that
 * message's {@link CallContext}. `EmitSubject` rejects request, wildcard and channel
 * subjects at compile time, so this helper is only reachable for concrete event
 * subjects.
 * @typeParam S - Event subject definition being emitted
 * @param globalBus - Global bus used for the enriched emission
 * @param call - Call context of the handled connector message
 * @param subject - Concrete event subject to emit to
 * @param payload - Event payload already enriched with agent identity
 */
async function forwardEmit<S extends SubjectDefinition>(
  globalBus: IMakaioBus,
  call: CallContext,
  subject: EmitSubject<S>,
  payload: object,
): Promise<void> {
  await globalBus.emit<S>(call, subject, payload as S['$meta']['payload']);
}

/**
 * Creates a type-safe event mapping from connector events to scoped subjects or handler functions.
 *
 * This function routes events from the connector's scoped bus to either:
 * 1. Another scoped subject (passthrough) - sessionId is stripped since it's not meaningful at SDK layer
 * 2. A handler function that can emit to global subjects
 * @param globalBus - Global bus for enriched emissions (handler functions only)
 * @param connector - The adapter connector to subscribe on
 * @param sourceSubject - The subject to subscribe to
 * @param nestedMessageProp - Property containing the discriminated union, or undefined for top-level
 * @param discriminator - The discriminator key within the message
 * @param handlers - Map of discriminator values to handlers or target subjects
 * @param enrich - Function to enrich payloads with AgentContext
 * @returns Unsubscribe function for the connector subscription
 */
export function createConnectorEventMapping<
  TConnector extends AIAgentConnector,
  TBus extends ScopedBus<string> = TConnector extends AIAgentConnector<infer B> ? B : never,
  TSourceSubject extends ScopedSubjectDefinition<TBus['namespace']> = ScopedSubjectDefinition<TBus['namespace']>,
  TNestedMessageProp extends keyof TSourceSubject['$meta']['payload'] | undefined = undefined,
  TMessage = TNestedMessageProp extends keyof TSourceSubject['$meta']['payload']
    ? TSourceSubject['$meta']['payload'][TNestedMessageProp]
    : TSourceSubject['$meta']['payload'],
  TDiscriminator extends DiscriminatorKeys<TMessage> = DiscriminatorKeys<TMessage>,
>(
  globalBus: IMakaioBus,
  connector: TConnector,
  sourceSubject: TSourceSubject,
  nestedMessageProp: TNestedMessageProp,
  discriminator: TDiscriminator,
  handlers: ConnectorEventHandlers<TMessage, TDiscriminator>,
  enrich: <TIn extends object>(call: CallContext, payload: TIn) => Promise<TIn & AgentIdentity>,
): () => void {
  // Create the emit helper that handlers can use, bound to the handled message's call
  const createEmitFn =
    (call: CallContext, enrichedPayload: object): ConnectorEmitFn =>
    async <S extends SubjectDefinition>(
      subject: S,
      payload: Omit<ExtractSubjectPayload<S>, keyof AgentContext>,
    ): Promise<void> => {
      // Merge the base enrichment (agentId, messageId, etc) with the provided payload
      const baseContext = enrichedPayload as AgentIdentity & { messageId?: string };
      const enrichedEmitPayload = {
        ...payload,
        agentId: baseContext.agentId,
        adapterId: baseContext.adapterId,
        adapterName: baseContext.adapterName,
        adapterSessionId: baseContext.adapterSessionId,
        messageId: baseContext.messageId,
      };
      await forwardEmit<S>(globalBus, call, subject as EmitSubject<S>, enrichedEmitPayload);
    };

  const handler = (async (context: RequestContext<unknown, unknown>) => {
    // Extract the message (nested or top-level)
    const message = nestedMessageProp
      ? (context.payload as Record<string, unknown>)[nestedMessageProp as string]
      : context.payload;

    if (!message || typeof message !== 'object') return;

    const discriminatorValue = (message as Record<string, unknown>)[discriminator] as keyof typeof handlers;
    const handlerOrSubject = handlers[discriminatorValue];

    if (!handlerOrSubject) return;

    // Enrich the message with AgentContext. Cast to `TMessage` (not just `object`) so the
    // enriched result stays type-related to `TMessage` for the discriminator narrowing below.
    const enrichedMessage = await enrich(context.call, message as TMessage & object);
    const emitFn = createEmitFn(context.call, enrichedMessage);

    if (typeof handlerOrSubject === 'function') {
      // `handlerOrSubject` is still correlated to the union of every discriminator
      // branch (TypeScript cannot narrow an indexed-access union by a runtime key
      // value), so the enriched message is asserted to the single branch the
      // runtime discriminator actually selected in one explicit, non-`never` cast.
      const narrowed: NarrowedMessage<TMessage, TDiscriminator, typeof discriminatorValue & string> =
        enrichedMessage as NarrowedMessage<TMessage, TDiscriminator, typeof discriminatorValue & string>;
      await handlerOrSubject(narrowed, emitFn);
    } else {
      // Subject definition passthrough - emit to scoped bus
      // Strip sessionId: connector events use adapterSessionId only (sessionId is Makaio orchestration-level)
      const { sessionId: _, ...connectorPayload } = enrichedMessage as AgentIdentity & { sessionId?: string };
      await forwardEmit(globalBus, context.call, handlerOrSubject, connectorPayload);
    }
  }) as HandlerForSubjectDefinition<TSourceSubject>;

  return connector.on(sourceSubject, handler);
}
