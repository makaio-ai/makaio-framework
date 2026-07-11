import type { ResolvedAdapterAuth } from '@makaio/ai-adapters-core/config';

/** Credential-free error for a missing or non-native Qwen auth snapshot. */
export class QwenNativeAuthDeliveryError extends Error {
  public constructor() {
    super('Qwen ACP native authentication delivery is invalid.');
    this.name = 'QwenNativeAuthDeliveryError';
  }
}

/**
 * Require the selected Qwen native-auth snapshot.
 * @param auth - Final connector-local authentication snapshot
 */
export function assertQwenNativeAuth(auth: ResolvedAdapterAuth | undefined): void {
  if (
    auth === undefined ||
    auth.configInheritance !== 'auth-only' ||
    Object.keys(auth.processEnv).length !== 0 ||
    auth.connectorDeliveries.length !== 0
  ) {
    throw new QwenNativeAuthDeliveryError();
  }
}
