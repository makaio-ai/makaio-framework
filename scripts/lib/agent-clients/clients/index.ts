/**
 * Probe contract registry.
 *
 * Registering a client here is the only central act required to make it
 * probe-able. Scenario generation resolves everything else through the
 * client's own {@link ClientProbeContract}.
 * @packageDocumentation
 */

import type { ClientProbeContract } from '../probe-contract.js';
import { claudeCodeProbeContract } from './claude-code.js';
import { codexProbeContract } from './codex.js';

const REGISTERED: readonly ClientProbeContract[] = [claudeCodeProbeContract, codexProbeContract];

const BY_CLIENT_ID: ReadonlyMap<string, ClientProbeContract> = new Map(
  REGISTERED.map((contract) => [contract.clientId, contract]),
);

/**
 * Resolve the probe contract for a registered client.
 * @param clientId - Stable client identifier.
 * @returns The registered probe contract.
 */
export function probeContractFor(clientId: string): ClientProbeContract {
  const contract = BY_CLIENT_ID.get(clientId);
  if (!contract) throw new Error(`No probe contract registered for client "${clientId}"`);
  return contract;
}
