/**
 * Registry of provider contract catalog entries.
 *
 * Provider contracts are registered by `(clientId, contractId)` pairs with
 * strict ownership semantics — only the registering extension may modify or
 * remove its contracts. Collisions from different extensions are rejected.
 *
 * The registry is an in-memory data structure, not a bus handler. It is
 * consumed by the {@link ClientHookResponseRegistry} during contributor
 * activation validation.
 * @packageDocumentation
 */

import type { ProviderContractCatalogEntry } from '@makaio/contracts/client';

/**
 * Composite key used to index provider contracts by `(clientId, contractId)`.
 * @param clientId - Client identifier (e.g. `'claude-code'`).
 * @param contractId - Stable contract identifier (e.g. `'anthropic.tool-response'`).
 * @returns Composite lookup key.
 */
function createContractKey(clientId: string, contractId: string): string {
  return `${clientId}\0${contractId}`;
}

/**
 * Validate a provider catalog before it becomes activation-time truth.
 * @param catalog - Provider contract catalog to validate.
 */
function validateCatalog(catalog: ProviderContractCatalogEntry): void {
  const hasText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
  if (catalog === null || typeof catalog !== 'object') {
    throw new Error('Provider contract catalog must be an object');
  }
  if (!hasText(catalog.clientId) || !hasText(catalog.contractId) || !hasText(catalog.version)) {
    throw new Error('Provider contract catalog requires non-empty clientId, contractId, and version');
  }
  if (!Array.isArray(catalog.supportedInteractions) || catalog.supportedInteractions.length === 0) {
    throw new Error('Provider contract catalog requires supported interactions');
  }
  if (
    catalog.supportedInteractions.some((interaction) => !hasText(interaction)) ||
    new Set(catalog.supportedInteractions).size !== catalog.supportedInteractions.length
  ) {
    throw new Error('Provider contract catalog interactions must be non-empty and unique');
  }
  if (!Array.isArray(catalog.blockability) || catalog.blockability.length !== catalog.supportedInteractions.length) {
    throw new Error('Provider contract catalog requires complete blockability metadata');
  }
  const blockability = new Map<string, boolean>();
  for (const entry of catalog.blockability) {
    if (!hasText(entry.interaction) || typeof entry.blockable !== 'boolean' || blockability.has(entry.interaction)) {
      throw new Error('Provider contract catalog blockability metadata must be complete and unique');
    }
    blockability.set(entry.interaction, entry.blockable);
  }
  if (
    catalog.supportedInteractions.some((interaction) => !blockability.has(interaction)) ||
    typeof catalog.validate !== 'function'
  ) {
    throw new Error(
      'Provider contract catalog must provide blockability metadata and a validator for every interaction',
    );
  }
}

/**
 * Internal record associating a provider contract catalog entry with its
 * owning extension.
 */
interface OwnedContractEntry {
  /** Extension that registered this contract. */
  readonly extensionId: string;
  /** The provider contract catalog entry. */
  readonly catalog: ProviderContractCatalogEntry;
}

/**
 * Registry of provider contract catalog entries keyed by
 * `(clientId, contractId)` with extension ownership.
 *
 * Rejects registration collisions when a different extension attempts to
 * register a contract for the same `(clientId, contractId)` pair. Supports
 * targeted unregistration by extension and cleanup of all contracts owned by
 * a single extension (for shutdown/disable paths).
 * @example
 * ```ts
 * const registry = new ClientHookProviderContractRegistry();
 * registry.registerProviderContract('ext-anthropic', catalog);
 * const entry = registry.getProviderContract('claude-code', 'anthropic.tool-response');
 * ```
 */
export class ClientHookProviderContractRegistry {
  private readonly entries = new Map<string, OwnedContractEntry>();

  /**
   * Register a provider contract catalog entry with extension ownership.
   *
   * The contract is keyed by `(catalog.clientId, catalog.contractId)`. If an
   * entry already exists for the same key, the call throws. An extension must
   * unregister before replacing its catalog so active contributors cannot be
   * silently invalidated.
   * @param extensionId - Extension that owns this contract registration.
   * @param catalog - Provider contract catalog entry to register.
   * @throws When a different extension already owns the same
   *   `(clientId, contractId)` pair.
   */
  public registerProviderContract(extensionId: string, catalog: ProviderContractCatalogEntry): void {
    validateCatalog(catalog);
    const key = createContractKey(catalog.clientId, catalog.contractId);
    const existing = this.entries.get(key);

    if (existing) {
      throw new Error(
        `Provider contract collision: contract '${catalog.contractId}' for ` +
          `client '${catalog.clientId}' is already registered by extension ` +
          `'${existing.extensionId}'; extension '${extensionId}' cannot claim it`,
      );
    }

    this.entries.set(key, { extensionId, catalog });
  }

  /**
   * Remove a specific provider contract registration.
   *
   * Only the owning extension may remove its own contract. If the contract
   * does not exist or belongs to a different extension, the call is a no-op.
   * @param extensionId - Extension requesting removal.
   * @param clientId - Client identifier of the contract to remove.
   * @param contractId - Contract identifier to remove.
   */
  public unregisterProviderContract(extensionId: string, clientId: string, contractId: string): void {
    const key = createContractKey(clientId, contractId);
    const existing = this.entries.get(key);

    if (existing && existing.extensionId === extensionId) {
      this.entries.delete(key);
    }
  }

  /**
   * Remove all provider contracts owned by the given extension.
   *
   * Used during extension shutdown or disable to clean up all contracts
   * registered by a single extension in one operation.
   * @param extensionId - Extension whose contracts should be removed.
   */
  public unregisterAllByExtension(extensionId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.extensionId === extensionId) {
        this.entries.delete(key);
      }
    }
  }

  /**
   * Look up a provider contract catalog entry by client and contract
   * identifiers.
   * @param clientId - Client identifier (e.g. `'claude-code'`).
   * @param contractId - Stable contract identifier.
   * @returns The registered catalog entry, or `undefined` when no matching
   *   contract is registered.
   */
  public getProviderContract(clientId: string, contractId: string): ProviderContractCatalogEntry | undefined {
    const key = createContractKey(clientId, contractId);
    return this.entries.get(key)?.catalog;
  }

  /**
   * Return all provider contracts registered for a given client.
   * @param clientId - Client identifier to filter by.
   * @returns Array of catalog entries registered for the client.
   */
  public getProviderContractsByClient(clientId: string): readonly ProviderContractCatalogEntry[] {
    const results: ProviderContractCatalogEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.catalog.clientId === clientId) {
        results.push(entry.catalog);
      }
    }
    return results;
  }

  /**
   * Return every active provider contract.
   *
   * Used to validate portable canonical contributors, whose omitted client
   * filter makes them eligible for every active client.
   * @returns Active provider contract catalog entries.
   */
  public getAllProviderContracts(): readonly ProviderContractCatalogEntry[] {
    return [...this.entries.values()].map((entry) => entry.catalog);
  }

  /**
   * Remove all registered provider contracts.
   */
  public clear(): void {
    this.entries.clear();
  }
}
