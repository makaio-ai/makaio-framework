import type { ClientOptions } from '@anthropic-ai/sdk';
import type { ResolvedAdapterAuth } from '@makaio/ai-adapters-core/config';

/** Connector target owned by the Anthropic SDK constructor boundary. */
export const ANTHROPIC_SDK_CONSTRUCTOR_TARGET = 'anthropic-sdk.constructor';

/** Credential-free error for malformed or foreign connector delivery. */
export class AnthropicSdkAuthDeliveryError extends Error {
  public constructor() {
    super('Anthropic SDK constructor authentication delivery is invalid.');
    this.name = 'AnthropicSdkAuthDeliveryError';
  }
}

/**
 * Consume the exact Anthropic constructor delivery while suppressing both SDK ambient fallbacks.
 * @param auth - Final connector-local authentication snapshot
 * @returns Explicit constructor authentication options
 */
export function resolveAnthropicConstructorAuth(
  auth: ResolvedAdapterAuth | undefined,
): Pick<ClientOptions, 'apiKey' | 'authToken'> {
  if (auth === undefined) return { apiKey: null, authToken: null };
  if (Object.keys(auth.processEnv).length !== 0 || auth.configInheritance !== 'empty') {
    throw new AnthropicSdkAuthDeliveryError();
  }
  const deliveries = auth.connectorDeliveries;
  if (deliveries.length === 0) return { apiKey: null, authToken: null };
  if (deliveries.length !== 1 || deliveries[0]?.target !== ANTHROPIC_SDK_CONSTRUCTOR_TARGET) {
    throw new AnthropicSdkAuthDeliveryError();
  }

  const values = deliveries[0].values;
  if (
    Object.keys(values).sort().join(',') !== 'apiKey,authToken' ||
    typeof values['apiKey'] !== 'string' ||
    values['apiKey'].trim() === '' ||
    values['authToken'] !== null
  ) {
    throw new AnthropicSdkAuthDeliveryError();
  }
  return { apiKey: values['apiKey'], authToken: null };
}
