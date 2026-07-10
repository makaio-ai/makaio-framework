import { RequestCorrelationContextSchema, type RequestCorrelationContext } from '@makaio/contracts';

/** Exact Factory Gateway headers accepted by its content-free usage boundary. */
export const FactoryUsageCorrelationHeaders = {
  sessionId: 'x-factory-session-id',
  turnId: 'x-factory-turn-id',
  messageId: 'x-factory-message-id',
  llmCallId: 'x-factory-llm-call-id',
  executionId: 'x-factory-execution-id',
  frameId: 'x-factory-frame-id',
} as const;

const HeaderSafeCorrelationIdSchema = RequestCorrelationContextSchema.shape.sessionId.unwrap();

const ProviderRequestCorrelationSchema = RequestCorrelationContextSchema.extend({
  /** Runtime-generated ID for the concrete API request. */
  llmCallId: HeaderSafeCorrelationIdSchema,
});

export type ProviderRequestCorrelation = RequestCorrelationContext & { llmCallId: string };

/**
 * Bind caller correlation to identifiers owned by the active runtime request.
 * Runtime values always win, preventing stale or spoofed session/message IDs.
 * @param context - Optional orchestrator-supplied workflow correlation
 * @param runtime - IDs known by the connector for this concrete API request
 * @returns Fully bound correlation including one LLM-call ID
 */
export function bindProviderRequestCorrelation(
  context: RequestCorrelationContext | undefined,
  runtime: { sessionId?: string; messageId: string; llmCallId: string },
): ProviderRequestCorrelation {
  return {
    ...context,
    ...(runtime.sessionId !== undefined ? { sessionId: runtime.sessionId } : {}),
    messageId: runtime.messageId,
    llmCallId: runtime.llmCallId,
  };
}

/**
 * Project a validated correlation context to the Factory Gateway allowlist.
 *
 * No arbitrary metadata or headers can cross this boundary. Callers must also
 * explicitly opt into the `factory-v1` transport mode before using the result.
 * @param correlation - Content-free runtime and workflow identifiers
 * @returns Header record accepted by the Factory Gateway usage boundary
 */
export function buildFactoryUsageCorrelationHeaders(correlation: ProviderRequestCorrelation): Record<string, string> {
  const parsed = ProviderRequestCorrelationSchema.parse(correlation);
  const headers: Record<string, string> = {};
  for (const [field, header] of Object.entries(FactoryUsageCorrelationHeaders)) {
    const value = parsed[field as keyof ProviderRequestCorrelation];
    if (value !== undefined) headers[header] = value;
  }
  return headers;
}
