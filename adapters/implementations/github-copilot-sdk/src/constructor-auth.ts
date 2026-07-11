import type { ResolvedAdapterAuth } from '@makaio/ai-adapters-core/config';

/** Connector target owned by the Copilot SDK client constructor. */
export const COPILOT_CONSTRUCTOR_TARGET = 'github-copilot-sdk.constructor';

/** Credential-free error for missing, malformed, or foreign Copilot delivery. */
export class CopilotSdkAuthDeliveryError extends Error {
  public constructor() {
    super('GitHub Copilot SDK constructor authentication delivery is invalid.');
    this.name = 'CopilotSdkAuthDeliveryError';
  }
}

/**
 * Consume the required Copilot constructor token delivery.
 * @param auth - Final connector-local authentication snapshot
 * @returns Selected GitHub token
 */
export function resolveCopilotGithubToken(auth: ResolvedAdapterAuth | undefined): string {
  const deliveries = auth?.connectorDeliveries ?? [];
  if (
    auth === undefined ||
    Object.keys(auth.processEnv).length !== 0 ||
    auth.configInheritance !== 'empty' ||
    deliveries.length !== 1 ||
    deliveries[0]?.target !== COPILOT_CONSTRUCTOR_TARGET
  ) {
    throw new CopilotSdkAuthDeliveryError();
  }
  const values = deliveries[0].values;
  if (
    Object.keys(values).join(',') !== 'githubToken' ||
    typeof values['githubToken'] !== 'string' ||
    values['githubToken'].trim() === ''
  ) {
    throw new CopilotSdkAuthDeliveryError();
  }
  return values['githubToken'];
}
