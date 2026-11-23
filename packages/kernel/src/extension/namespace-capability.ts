import type { IMakaioBus } from '@makaio/bus-core';
import { busContextOf, leaseNamespace, type CarrierNamespaceRegistration } from '@makaio/bus-core/kernel-api';
import type { BusNamespaceDefinition, SubjectSchema } from '@makaio/core';
import type { ExtensionIdentity } from '@makaio/contracts';
import {
  NAMESPACE_CAPABILITY_CLOSED,
  type NamespaceCapability,
  type NamespaceLease,
} from '@makaio/contracts/extension';

interface NamespaceClaims {
  readonly capability: NamespaceCapability;
  readonly registerNamespace: CarrierNamespaceRegistration;
  releaseAll(): void;
}

const claimsByIdentity = new WeakMap<ExtensionIdentity, NamespaceClaims>();
const closedIdentities = new WeakSet<ExtensionIdentity>();

/** A namespace claim attempted after the extension capability was closed. */
export class NamespaceCapabilityClosedError extends Error {
  public readonly code = NAMESPACE_CAPABILITY_CLOSED;

  /**
   * Describe a claim rejected because the capability was closed.
   * @param extension - Name of the extension whose capability was closed.
   */
  public constructor(extension: ExtensionIdentity['extensionName']) {
    super(`Namespace capability for extension '${extension}' is closed.`);
    this.name = 'NamespaceCapabilityClosedError';
  }
}

/**
 * Get the namespace claims shared by contexts in the entry's current generation.
 * @param bus - Host bus that owns the namespace registry.
 * @param identity - Coordinator-minted identity of the entry.
 * @returns The extension-bound claim paths.
 */
function namespaceClaimsFor(bus: IMakaioBus, identity: ExtensionIdentity): NamespaceClaims {
  const existing = claimsByIdentity.get(identity);
  if (existing) return existing;

  const holder = { kind: 'extension', extension: identity.extensionName } as const;
  const leases = new Set<NamespaceLease>();
  /**
   * Claim a namespace and retain its lease for entry teardown.
   * @param definition - Namespace definition to register.
   * @returns The lease and registered namespace for this claim.
   */
  function claim<Domain extends string, Schemas extends Record<string, SubjectSchema>>(
    definition: BusNamespaceDefinition<Domain, Schemas>,
  ) {
    if (closedIdentities.has(identity) || claimsByIdentity.get(identity) !== claims) {
      throw new NamespaceCapabilityClosedError(identity.extensionName);
    }
    const registration = leaseNamespace(bus, definition, holder);
    const lease: NamespaceLease = {
      /** Forget this lease as soon as its claim is released. */
      release() {
        if (leases.delete(lease)) registration.release();
      },
    };
    leases.add(lease);
    return { lease, namespace: registration.namespace };
  }

  const claims: NamespaceClaims = {
    capability: {
      lease: (definition) => claim(definition as BusNamespaceDefinition).lease,
    },
    registerNamespace: (definition, recordLease) => {
      if (process.env['MAKAIO_DEBUG'] === 'true') {
        busContextOf(bus).debugLog(
          `[MakaioBus] Redirecting registration to extension '${holder.extension}' for namespace '${definition.name}'.`,
        );
      }
      const { lease, namespace } = claim(definition);
      recordLease?.(lease);
      return namespace;
    },
    /** Release and forget the leases held by this entry. */
    releaseAll() {
      for (const lease of leases) lease.release();
    },
  };
  claimsByIdentity.set(identity, claims);
  return claims;
}

/**
 * Get the namespace capability for the entry’s current generation.
 * @param bus - Host bus that owns the namespace registry.
 * @param identity - Coordinator-minted identity of the entry.
 * @returns The extension-bound namespace capability.
 */
export function namespaceCapabilityFor(bus: IMakaioBus, identity: ExtensionIdentity): NamespaceCapability {
  return namespaceClaimsFor(bus, identity).capability;
}

/**
 * Bind legacy carrier registration to the entry’s current generation.
 * @param bus - Host bus that owns the namespace registry.
 * @param identity - Coordinator-minted identity of the entry.
 * @returns The registration function that acquires a tracked extension lease.
 */
export function namespaceRegistrationFor(bus: IMakaioBus, identity: ExtensionIdentity): CarrierNamespaceRegistration {
  return namespaceClaimsFor(bus, identity).registerNamespace;
}

/**
 * Allow activation to create a fresh capability after the previous one closed.
 * @param identity - Coordinator-minted identity of the entry being activated.
 */
export function reopenExtensionNamespaces(identity: ExtensionIdentity): void {
  if (closedIdentities.delete(identity)) claimsByIdentity.delete(identity);
}

/**
 * Close the extension entry’s namespace capability and release every runtime claim.
 * @param identity - Coordinator-minted identity of the entry being torn down.
 */
export function releaseExtensionNamespaces(identity: ExtensionIdentity): void {
  closedIdentities.add(identity);
  claimsByIdentity.get(identity)?.releaseAll();
}
