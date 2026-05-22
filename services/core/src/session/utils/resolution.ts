import type { IMakaioBus } from '@makaio/bus-core';
import { type ReasoningLevelMap } from '@makaio/contracts';
import { AdapterRuntimeSubjects } from '../../adapter-runtime/namespace.js';
import { AdapterSubsystemSubjects } from '../../adapter-subsystem/namespace.js';
import { ProviderStorageSubjects } from '../../settings/storage/providers-namespace.js';
import { ExecutionTargetSubjects } from '../../execution-target/namespace.js';
import type { ExecutionTarget } from '../../execution-target/schemas.js';

/**
 * Resolve adapterName → adapterId for bus routing.
 * Queries the adapters table for a local enabled instance.
 * @param bus - Bus instance
 * @param adapterName - Adapter type name
 * @param machineId - Optional machine ID for deterministic local resolution
 * @returns Canonical adapter ID for bus routing
 * @throws if no enabled instance found for this adapterName
 */
export async function resolveAdapterId(bus: IMakaioBus, adapterName: string, machineId?: string): Promise<string> {
  const { adapterId } = await bus.request(AdapterRuntimeSubjects.resolveId, {
    adapterName,
    ...(machineId !== undefined && { machineId }),
  });
  return adapterId;
}

/**
 * Resolve supported reasoning levels for a model from provider definitions.
 *
 * Looks up the provider config by ID, finds the provider definition it belongs to,
 * then finds the model's `supportedReasoningLevels` in the provider's `availableModels`
 * catalog.
 * @param bus - Bus instance for RPC calls
 * @param providerConfigId - Canonical provider config ID (ProviderConfigRecord.id)
 * @param model - Model identifier to look up in the provider's catalog
 * @returns Object with `supportedReasoningLevels` when found, or `undefined` when not resolvable
 */
export async function resolveModelCapabilities(
  bus: IMakaioBus,
  providerConfigId: string | undefined,
  model: string | undefined,
): Promise<{ supportedReasoningLevels?: ReasoningLevelMap } | undefined> {
  if (!providerConfigId || !model) return undefined;

  try {
    const { config } = await bus.request(AdapterSubsystemSubjects.getProviderConfig, { id: providerConfigId });
    if (!config) return undefined;

    const { provider } = await bus.request(ProviderStorageSubjects.get, { id: config.definitionId });
    const modelDef = provider?.availableModels?.find((m) => m.name === model);
    return modelDef ? { supportedReasoningLevels: modelDef.supportedReasoningLevels } : undefined;
  } catch {
    // Bus errors (e.g., no handler registered, timeout) are treated as soft failures.
    // Capability resolution is best-effort; callers proceed without reasoning metadata.
    return undefined;
  }
}

/**
 * Resolves the effective execution target for a session.
 * Priority: explicit executionTargetId → workstream default → system default (local).
 * @param bus - Makaio bus instance
 * @param params - Resolution parameters from session context
 * @returns Resolved execution target
 */
export async function resolveExecutionTarget(
  bus: IMakaioBus,
  params: {
    executionTargetId?: string;
    workstreamId?: string;
    projectId?: string;
  },
): Promise<ExecutionTarget> {
  const { executionTarget } = await bus.request(ExecutionTargetSubjects.resolve, params);
  return executionTarget;
}
