import type { IMakaioBus } from '@makaio/bus-core';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';
import type { AttachIdentity } from './attach-execution-types.js';
import { stopStartedAgentAfterFailure } from './attach-turn-tracking.js';

/**
 * Persist identity metadata needed for recovery and downstream services.
 * @param bus - Bus providing agent storage.
 * @param params - Started agent identity and runtime metadata.
 * @returns Whether an identity record was written.
 */
async function persistAgentIdentity(
  bus: IMakaioBus,
  params: AttachIdentity & { agentId: string; adapterId: string },
): Promise<boolean> {
  if (!params.personaId && !params.profileId && !params.harnessId && !params.providerConfigId) return false;
  await bus.request(AgentStorageSubjects.set, {
    agentId: params.agentId,
    agent: {
      agentId: params.agentId,
      adapterId: params.adapterId,
      adapterName: params.adapterName,
      sessionId: params.sessionId,
      role: params.role,
      status: 'idle',
      personaId: params.personaId,
      profileId: params.profileId,
      harnessId: params.harnessId,
      providerConfigId: params.providerConfigId,
      createdAt: params.timestamp,
      lastActivityAt: params.timestamp,
      ...(params.model !== undefined && { model: params.model }),
      ...(params.cwd !== undefined && { cwd: params.cwd }),
      ...(params.compressionMode !== undefined && { compressionMode: params.compressionMode }),
    },
  });
  return true;
}

/**
 * Persist identity metadata and rollback the started adapter agent on failure.
 * @param bus - Bus instance for persistence and rollback calls.
 * @param startResult - Started adapter and agent identity.
 * @param identity - Identity payload to persist.
 * @returns Whether an identity record was written.
 */
export async function persistIdentityOrRollback(
  bus: IMakaioBus,
  startResult: { agentId: string; adapterId: string },
  identity: AttachIdentity,
): Promise<boolean> {
  try {
    return await persistAgentIdentity(bus, { ...identity, ...startResult });
  } catch (error) {
    console.error('[attach-handler] Failed to persist agent identity, rolling back started agent', {
      sessionId: identity.sessionId,
      agentId: startResult.agentId,
      adapterId: startResult.adapterId,
      error,
    });
    await stopStartedAgentAfterFailure(bus, startResult, identity.sessionId, 'identity persistence failure');
    throw error;
  }
}

/**
 * Remove identity persisted before a later attach stage failed.
 * @param bus - Bus providing agent identity storage.
 * @param agentId - Started agent whose identity must be rolled back.
 * @param attachError - Attach error that triggered rollback.
 * @returns Primary failure, or an aggregate that also records delete failure.
 */
export async function rollbackPersistedIdentity(
  bus: IMakaioBus,
  agentId: string,
  attachError: unknown,
): Promise<unknown> {
  try {
    const { success } = await bus.request(AgentStorageSubjects.delete, { agentId });
    if (!success) throw new Error(`Persisted agent identity was not deleted: ${agentId}`);
    return attachError;
  } catch (deleteError) {
    return new AggregateError(
      [attachError, deleteError],
      `Failed to rollback agent identity after attach failure: ${agentId}`,
    );
  }
}
