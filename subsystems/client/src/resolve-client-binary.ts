/**
 * Utility for resolving a client binary execution context via the bus.
 * @packageDocumentation
 */

import type { IMakaioBus } from '@makaio/bus-core';
import { ClientSubjects } from '@makaio/contracts/client';
import type { ClientExecutionContext } from '@makaio/contracts/client';

/**
 * Resolve the execution context for a client binary via the bus.
 *
 * Uses `requestOptional` so the adapter continues to function in
 * framework-only boot where no `client.resolveBinary` handler is registered.
 * In that case `undefined` is returned and callers fall back to PATH lookup.
 * @param bus - Runtime bus that owns the client-resolution handlers.
 * @param clientId - Stable client identifier to resolve (e.g. `'claude-code'`)
 * @returns Resolved execution context (source `'managed'` or `'global'`), or
 *   `undefined` when no `client.resolveBinary` handler is registered
 *   (framework-only boot)
 */
export async function resolveClientBinary(
  bus: IMakaioBus,
  clientId: string,
): Promise<ClientExecutionContext | undefined> {
  const result = await bus.requestOptional(ClientSubjects.resolveBinary, { clientId });
  return result.handled ? result.data : undefined;
}
