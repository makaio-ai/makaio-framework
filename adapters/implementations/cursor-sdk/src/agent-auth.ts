import type { ResolvedAdapterAuth } from '@makaio/ai-adapters-core/config';

/** Connector target owned by Cursor `Agent.create`. */
export const CURSOR_AGENT_CREATE_TARGET = 'cursor-sdk.agent-create';

/** Credential-free error for missing, malformed, or foreign Cursor delivery. */
export class CursorSdkAuthDeliveryError extends Error {
  public constructor() {
    super('Cursor SDK agent authentication delivery is invalid.');
    this.name = 'CursorSdkAuthDeliveryError';
  }
}

/**
 * Consume the required Cursor API-key delivery.
 * @param auth - Final connector-local authentication snapshot
 * @returns Selected Cursor API key
 */
export function resolveCursorAgentApiKey(auth: ResolvedAdapterAuth | undefined): string {
  const deliveries = auth?.connectorDeliveries ?? [];
  if (
    auth === undefined ||
    Object.keys(auth.processEnv).length !== 0 ||
    auth.configInheritance !== 'empty' ||
    deliveries.length !== 1 ||
    deliveries[0]?.target !== CURSOR_AGENT_CREATE_TARGET
  ) {
    throw new CursorSdkAuthDeliveryError();
  }
  const values = deliveries[0].values;
  if (
    Object.keys(values).join(',') !== 'apiKey' ||
    typeof values['apiKey'] !== 'string' ||
    values['apiKey'].trim() === ''
  ) {
    throw new CursorSdkAuthDeliveryError();
  }
  return values['apiKey'];
}
