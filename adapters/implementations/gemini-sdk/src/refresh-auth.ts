import type { ResolvedAdapterAuth } from '@makaio/ai-adapters-core/config';
import type { GeminiAuthOptions } from './utils/init-gemini.js';

/** Connector target owned by Gemini `Config.refreshAuth`. */
export const GEMINI_REFRESH_AUTH_TARGET = 'gemini-sdk.refresh-auth';

/** Credential-free error for a missing, malformed, or foreign Gemini delivery. */
export class GeminiSdkAuthDeliveryError extends Error {
  public constructor() {
    super('Gemini SDK authentication delivery is invalid.');
    this.name = 'GeminiSdkAuthDeliveryError';
  }
}

/**
 * Consume Gemini's explicit API-key authentication delivery.
 * @param auth - Final connector-local authentication snapshot
 * @returns API-key options for the Gemini SDK.
 */
export function resolveGeminiAuthOptions(auth: ResolvedAdapterAuth | undefined): GeminiAuthOptions {
  if (auth === undefined) throw new GeminiSdkAuthDeliveryError();
  if (Object.keys(auth.processEnv).length !== 0) throw new GeminiSdkAuthDeliveryError();
  const deliveries = auth.connectorDeliveries;
  if (auth.configInheritance !== 'empty') throw new GeminiSdkAuthDeliveryError();
  if (deliveries.length !== 1 || deliveries[0]?.target !== GEMINI_REFRESH_AUTH_TARGET) {
    throw new GeminiSdkAuthDeliveryError();
  }
  const values = deliveries[0].values;
  if (
    Object.keys(values).join(',') !== 'apiKey' ||
    typeof values['apiKey'] !== 'string' ||
    values['apiKey'].trim() === ''
  ) {
    throw new GeminiSdkAuthDeliveryError();
  }
  return { apiKey: values['apiKey'] };
}
