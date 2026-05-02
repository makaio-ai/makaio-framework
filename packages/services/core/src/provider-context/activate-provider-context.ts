import type { IMakaioBus } from '@makaio/bus-core';
import { CredentialSubjects, type ProviderContext } from '@makaio/contracts';

/**
 * Build the activation payload from a provider context.
 * Centralizes mapping so strict and best-effort paths stay locked to one shape.
 * @param providerContext - Provider context whose refs should be activated
 * @returns The credential activation request payload
 */
function buildActivationPayload(providerContext: ProviderContext) {
  return {
    providerConfigId: providerContext.providerConfigId,
    definitionId: providerContext.definitionId,
    credentialRefs: providerContext.credentialRefs,
  };
}

/**
 * Send the raw credential activation request through the bus.
 * @param bus - Bus used to invoke the activation hook
 * @param providerContext - Provider context whose refs should be activated
 */
async function requestCredentialActivation(bus: IMakaioBus, providerContext: ProviderContext): Promise<void> {
  await bus.request(CredentialSubjects.activate, buildActivationPayload(providerContext));
}

/**
 * Fire the credential activation hook for a provider context.
 *
 * Callers await this before starting an adapter so extensions such as
 * account-manager can prepare native credential stores ahead of connector-side
 * resolution. Missing handlers are treated as a no-op and handler failures are
 * intentionally suppressed because activation must not block agent startup.
 * @param bus - Bus used to invoke the activation hook
 * @param providerContext - Provider context whose refs should be activated
 */
export async function activateProviderContext(bus: IMakaioBus, providerContext: ProviderContext): Promise<void> {
  try {
    const result = await bus.requestOptional(CredentialSubjects.activate, buildActivationPayload(providerContext));

    if (!result.handled) {
      return;
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[activateProviderContext] credential.activate handler failed:', message);
  }
}

/**
 * Fire the credential activation hook and propagate failures.
 *
 * Rotation paths use this stricter variant so a failed native-store update does
 * not report a successful credential swap.
 * @param bus - Bus used to invoke the activation hook
 * @param providerContext - Provider context whose refs should be activated
 */
export async function activateProviderContextStrict(bus: IMakaioBus, providerContext: ProviderContext): Promise<void> {
  await requestCredentialActivation(bus, providerContext);
}
