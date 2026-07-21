import type { IMakaioBus } from '@makaio/bus-core';
import { SessionSubjects, type SubagentConfig } from '@makaio/contracts';
import {
  resolveRuntimeProviderContext,
  RuntimeProviderContextResolutionError,
} from '@makaio/services-core/provider-context';
import { buildSubagentAgentSelection } from './agent-selection.js';

/** Inputs for atomic subagent adapter attach and initial-task admission. */
export interface SubagentAttachParams {
  subagentId: string;
  adapterName: string;
  config: SubagentConfig;
  sessionId: string;
  task: string;
  targetWorkingDirectory: string | undefined;
  assertAdmission: () => void;
}

/**
 * Attach a subagent and admit its initial task as one session transaction.
 * @param bus - Bus providing provider resolution and session attach.
 * @param params - Resolved subagent attach inputs and admission assertion.
 */
export async function attachSubagent(bus: IMakaioBus, params: SubagentAttachParams): Promise<void> {
  const { subagentId, adapterName, config, sessionId, task, targetWorkingDirectory, assertAdmission } = params;
  const suppliedProviderContext = config.providerContext;
  if (
    suppliedProviderContext?.state === 'resolved' &&
    config.providerConfigId !== undefined &&
    config.providerConfigId !== suppliedProviderContext.providerConfigId
  ) {
    throw new Error(
      `Subagent providerConfigId "${config.providerConfigId}" does not match its resolved provider context "${suppliedProviderContext.providerConfigId}".`,
    );
  }
  if (suppliedProviderContext?.state === 'unresolved' && config.providerConfigId !== undefined) {
    throw new RuntimeProviderContextResolutionError(
      'provider-context-unresolved',
      adapterName,
      config.providerConfigId,
    );
  }
  const providerContext =
    suppliedProviderContext ??
    (config.providerConfigId
      ? await resolveRuntimeProviderContext(bus, { adapterName, providerConfigId: config.providerConfigId })
      : undefined);
  await bus.request(
    SessionSubjects.agent.attachResolved,
    {
      sessionId,
      role: 'lead',
      initialMessage: task,
      source: 'system',
      assertInitialMessageAdmission: () => {
        try {
          assertAdmission();
        } catch {
          throw new Error(`Subagent startup was cancelled before initial task admission: ${subagentId}`);
        }
      },
      ...(config.responseSchema !== undefined && { responseSchema: config.responseSchema }),
      ...(config.harnessId !== undefined && { harnessId: config.harnessId }),
      agent: buildSubagentAgentSelection(adapterName, config, providerContext, targetWorkingDirectory),
    },
    // The local composite has no competing outer deadline. Its constituent
    // session, adapter, storage, and routing RPCs each retain their bounded
    // timeout and therefore preserve stage-specific failure classification.
    { timeout: 0 },
  );
}
