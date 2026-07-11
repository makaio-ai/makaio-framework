import type { ClientOptions } from 'openai';
import type { ResolvedAdapterAuth } from '@makaio/ai-adapters-core/config';

/** Connector target owned by the OpenAI Node constructor boundary. */
export const OPENAI_NODE_CONSTRUCTOR_TARGET = 'openai-node.constructor';

/** Credential-free error for malformed or foreign connector delivery. */
export class OpenAINodeAuthDeliveryError extends Error {
  public constructor() {
    super('OpenAI Node constructor authentication delivery is invalid.');
    this.name = 'OpenAINodeAuthDeliveryError';
  }
}

/**
 * Consume the exact OpenAI constructor delivery while suppressing SDK ambient fallbacks.
 * @param auth - Final connector-local authentication snapshot
 * @returns Explicit constructor authentication options
 */
export function resolveOpenAIConstructorAuth(
  auth: ResolvedAdapterAuth | undefined,
): Pick<ClientOptions, 'apiKey' | 'adminAPIKey'> {
  if (auth === undefined) return { apiKey: null, adminAPIKey: null };
  if (Object.keys(auth.processEnv).length !== 0 || auth.configInheritance !== 'empty') {
    throw new OpenAINodeAuthDeliveryError();
  }
  const deliveries = auth.connectorDeliveries;
  if (deliveries.length === 0) return { apiKey: null, adminAPIKey: null };
  if (deliveries.length !== 1 || deliveries[0]?.target !== OPENAI_NODE_CONSTRUCTOR_TARGET) {
    throw new OpenAINodeAuthDeliveryError();
  }

  const values = deliveries[0].values;
  if (
    Object.keys(values).sort().join(',') !== 'adminAPIKey,apiKey' ||
    typeof values['apiKey'] !== 'string' ||
    values['apiKey'].trim() === '' ||
    values['adminAPIKey'] !== null
  ) {
    throw new OpenAINodeAuthDeliveryError();
  }
  return { apiKey: values['apiKey'], adminAPIKey: null };
}
