import type { ExtensionIdentity } from '@makaio/contracts/extension';

const activationLifetimes = new WeakMap<ExtensionIdentity, AbortController>();

/**
 * Gets the generation signal shared by capabilities of this activation.
 * @param identity - Trusted entry identity.
 * @returns The signal for the current activation.
 */
export function extensionGenerationSignal(identity: ExtensionIdentity): AbortSignal {
  const lifetime = activationLifetimes.get(identity) ?? new AbortController();
  activationLifetimes.set(identity, lifetime);
  return lifetime.signal;
}

/**
 * Abort the generation and release its bound capabilities.
 * @param identity - Trusted identity of the entry being released.
 */
export function closeExtensionGeneration(identity: ExtensionIdentity): void {
  const lifetime = activationLifetimes.get(identity) ?? new AbortController();
  activationLifetimes.set(identity, lifetime);
  lifetime.abort();
}

/**
 * Make the next access create a fresh generation after a stop.
 * @param identity - Trusted identity of the entry being activated.
 */
export function reopenExtensionGeneration(identity: ExtensionIdentity): void {
  if (activationLifetimes.get(identity)?.signal.aborted) activationLifetimes.delete(identity);
}
