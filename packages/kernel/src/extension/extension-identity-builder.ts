import type { ExtensionIdentity } from '@makaio/contracts';

/**
 * Mint an extension identity for coordinator-owned context injection.
 * @param extensionName - Extension name this identity represents.
 * @returns Opaque extension identity.
 */
export function createExtensionIdentity(extensionName: string): ExtensionIdentity {
  return Object.freeze({ extensionName }) as ExtensionIdentity;
}
