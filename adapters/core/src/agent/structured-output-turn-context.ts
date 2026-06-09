import type { JsonValue, ResponseSchemaDescriptor } from '@makaio/contracts';

/**
 * Merge structured-output JSON instructions into the turn context for adapters
 * that do not natively support structured output.
 * @param turnContext - Existing turn context for the outgoing turn, if any
 * @param responseSchema - Active response schema descriptor, if any
 * @param adapterCapabilities - Capability tags reported by the adapter
 * @returns Augmented turn context, or the original value when no injection is needed
 */
export function buildStructuredOutputTurnContext(
  turnContext: Record<string, JsonValue> | undefined,
  responseSchema: ResponseSchemaDescriptor | undefined,
  adapterCapabilities: readonly string[],
): Record<string, JsonValue> | undefined {
  if (!responseSchema || adapterCapabilities.includes('structuredOutput')) {
    return turnContext;
  }
  return {
    ...turnContext,
    structuredOutput:
      `Respond ONLY with valid JSON conforming to this schema:\n${JSON.stringify(responseSchema.schema, null, 2)}\n` +
      'Do not include any other text, markdown formatting, or explanation.',
  };
}
