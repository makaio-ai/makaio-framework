import { createBusNamespace } from '@makaio/core';
import type { BusNamespaceDefinition, SchemaRecord } from '@makaio/core';

/**
 * Declarative storage namespace definition used by contracts.
 *
 * This mirrors the public shape consumed by storage runtimes without importing
 * `@makaio/storage-core`, keeping `@makaio/contracts` pure.
 */
export interface ContractStorageNamespaceDefinition<
  Domain extends string = string,
  Schemas extends SchemaRecord = SchemaRecord,
  Extensions extends Record<string, unknown> = Record<string, never>,
> extends BusNamespaceDefinition<`storage:${Domain}`, Schemas> {
  /** Storage domain without the `storage:` prefix. */
  readonly domain: Domain;
  /** Optional storage metadata carried for runtime handler wiring. */
  readonly extensions: Extensions;
}

/**
 * Create a pure storage namespace definition for contracts-owned schemas.
 * @param domain - Storage domain without the `storage:` prefix
 * @param config - Storage schema record and optional metadata
 * @returns Declarative storage namespace definition
 */
export function createContractStorageNamespace<
  Domain extends string,
  Schemas extends SchemaRecord,
  Extensions extends Record<string, unknown> = Record<string, never>,
>(
  domain: Domain,
  config: { readonly schemas: Schemas; readonly extensions?: Extensions },
): ContractStorageNamespaceDefinition<Domain, Schemas, Extensions> {
  return {
    ...createBusNamespace(`storage:${domain}`, config.schemas),
    domain,
    extensions: config.extensions ?? ({} as Extensions),
  };
}
