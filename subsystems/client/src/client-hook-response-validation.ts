/**
 * Runtime validation for extension-provided client hook responses.
 * @packageDocumentation
 */

import type {
  ContributorDefinition,
  ContributorResponse,
  ProviderContractCatalogEntry,
} from '@makaio/contracts/client';

/**
 * Validate canonical effects at the untyped extension boundary.
 * @param effects - Runtime effect value returned by a contributor.
 * @returns `true` when every effect is a complete `context.append` effect.
 */
function validateCanonicalEffects(effects: ContributorResponse['canonicalEffects']): true | string {
  if (effects === undefined) return true;
  if (!Array.isArray(effects)) return 'canonicalEffects must be an array';

  for (const effect of effects) {
    if (
      typeof effect !== 'object' ||
      effect === null ||
      effect.kind !== 'context.append' ||
      typeof effect.value !== 'string'
    ) {
      return 'canonicalEffects must contain complete context.append effects';
    }
    if (Object.keys(effect).some((key) => key !== 'kind' && key !== 'value')) {
      return 'canonicalEffects must contain only kind and value';
    }
  }
  return true;
}

/**
 * Validate a provider envelope against its contributor's exact lane identity.
 * @param envelope - Runtime provider envelope value.
 * @param clientId - Client declared by the provider contributor.
 * @param contractId - Contract declared by the provider contributor.
 * @returns `true` when the envelope has the exact expected shape and identity.
 */
function validateProviderEnvelope(
  envelope: ContributorResponse['providerEnvelope'],
  clientId: string,
  contractId: string,
): true | string {
  if (envelope === undefined) return true;
  if (
    typeof envelope !== 'object' ||
    envelope === null ||
    Array.isArray(envelope) ||
    envelope.clientId !== clientId ||
    envelope.contractId !== contractId ||
    typeof envelope.effects !== 'object' ||
    envelope.effects === null ||
    Array.isArray(envelope.effects)
  ) {
    return 'providerEnvelope must contain the exact clientId, contractId, and an effects object';
  }
  if (Object.keys(envelope).some((key) => key !== 'clientId' && key !== 'contractId' && key !== 'effects')) {
    return 'providerEnvelope must contain only clientId, contractId, and effects';
  }
  return true;
}

/**
 * Validate provider identity and delegate its effects to the exact contract.
 * @param response - Provider contributor response.
 * @param definition - Provider contributor definition.
 * @param clientId - Client receiving the hook event.
 * @param providerContract - Exact active provider contract for this request.
 * @param eventName - Hook event name.
 * @param eventPayload - Hook event payload.
 * @returns `true` when identity, envelope, and provider effects are valid.
 */
function validateProviderResponse(
  response: ContributorResponse,
  definition: Extract<ContributorDefinition, { lane: 'provider' }>,
  clientId: string,
  providerContract: ProviderContractCatalogEntry | undefined,
  eventName: string,
  eventPayload: unknown,
): true | string {
  if (!providerContract) return `Provider contributor requires active contract '${definition.contractId}'`;
  if (providerContract.clientId !== clientId || providerContract.clientId !== definition.clientId) {
    return `Provider contract client '${providerContract.clientId}' does not match '${definition.clientId}'`;
  }
  if (providerContract.contractId !== definition.contractId) {
    return `Provider contract '${providerContract.contractId}' does not match '${definition.contractId}'`;
  }

  const envelopeValidation = validateProviderEnvelope(
    response.providerEnvelope,
    definition.clientId,
    definition.contractId,
  );
  if (envelopeValidation !== true) return envelopeValidation;
  return providerContract.validate(response, { clientId, eventName, eventPayload });
}

/**
 * Validate a complete contributor response before provider reduction.
 * @param response - Runtime callback response.
 * @param definition - Contributor definition that produced the response.
 * @param clientId - Client receiving the hook event.
 * @param providerContract - Exact active provider contract for this request.
 * @param eventName - Hook event name.
 * @param eventPayload - Hook event payload.
 * @returns `true` when the response belongs to the declared lane and contract.
 */
export function validateContributorResponse(
  response: ContributorResponse | undefined,
  definition: ContributorDefinition,
  clientId: string,
  providerContract: ProviderContractCatalogEntry | undefined,
  eventName: string,
  eventPayload: unknown,
): true | string {
  if (response === undefined) return true;
  if (typeof response !== 'object' || response === null || Array.isArray(response)) {
    return 'Contributor response must be an object or undefined';
  }

  const allowedKeys = definition.lane === 'canonical' ? ['canonicalEffects'] : ['providerEnvelope'];
  if (Object.keys(response).some((key) => !allowedKeys.includes(key))) {
    return `Contributor response contains keys outside the ${definition.lane} lane`;
  }
  if (definition.lane === 'canonical') {
    return validateCanonicalEffects(response.canonicalEffects);
  }
  return validateProviderResponse(response, definition, clientId, providerContract, eventName, eventPayload);
}
