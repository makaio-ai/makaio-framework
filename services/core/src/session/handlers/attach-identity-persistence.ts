import type { IMakaioBus } from '@makaio/bus-core';
import type { StartAgentRequest } from '@makaio/contracts';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';
import type { AttachIdentity } from './attach-execution-types.js';
import { buildCallerOwnedAgentRow } from './lead-start-request.js';
import type { MachineScopedAdapterInstance } from '../utils/resolution.js';

/** Identity and runtime facts one attach persists before it dispatches. */
export interface AttachAgentRowInput {
  /** Caller-minted agent identity; attach owns this row. */
  readonly agentId: string;
  /** Exact runtime instance the row is reserved and dispatched against. */
  readonly instance: MachineScopedAdapterInstance;
  /** Identity metadata resolved for the attach. */
  readonly identity: AttachIdentity;
  /** The runtime facts the dispatch will carry. */
  readonly runtime: Pick<StartAgentRequest, 'model' | 'cwd' | 'allowedDirectories' | 'clientId' | 'harnessId'>;
}

/**
 * Write the `starting` agent row an attach reserves and dispatches under.
 *
 * **Pre-dispatch, and through the same builder a fresh lead start uses.** Attach
 * used to write a whole record *after* the dispatch, with `status: 'idle'` and a
 * narrower field set — which under the reserved attach is wrong twice over. The
 * late write would overwrite the `starting` the reservation depends on before
 * the settlement could run, and the narrow field set would silently lose every
 * field the adapter's own suppressed row write used to supply:
 * `allowedDirectories` and `clientId` are written by *nobody* once `agentId` is
 * supplied, so a second builder here would drop them without a symptom.
 *
 * The short-circuit that skipped the write for an attach with no persona,
 * profile, harness or provider config is gone with it: a reserved start has to
 * have a row, because the reservation checks the agent's membership against one.
 * @param bus - Bus the write is issued on.
 * @param input - Identity, adapter binding and runtime facts of the attach.
 */
export async function persistAttachAgentRow(bus: IMakaioBus, input: AttachAgentRowInput): Promise<void> {
  const { identity } = input;
  // `requestOptional`, exactly as the fresh lead start writes its own row: a host
  // with no agent storage is refused a page later, by the reservation that reads
  // the row — the seam that can say what is missing and why.
  await bus.requestOptional(AgentStorageSubjects.set, {
    agentId: input.agentId,
    agent: buildCallerOwnedAgentRow({
      agentId: input.agentId,
      instance: input.instance,
      adapterName: identity.adapterName,
      sessionId: identity.sessionId,
      role: identity.role,
      runtime: input.runtime,
      ...(identity.providerConfigId !== undefined && { providerConfigId: identity.providerConfigId }),
      ...(identity.personaId !== undefined && { personaId: identity.personaId }),
      ...(identity.profileId !== undefined && { profileId: identity.profileId }),
      ...(identity.compressionMode !== undefined && { compressionMode: identity.compressionMode }),
    }),
  });
}
