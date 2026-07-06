/**
 * Capability seam for observed-session content ingestion policy.
 *
 * Hosts can opt into this provider to decide whether observed client sessions
 * should be content-imported (`tracking`) or only registered as metadata
 * (`discovered`). With no provider registered, observed ingestion keeps the
 * default `tracking` behavior.
 * @packageDocumentation
 */

import type { IMakaioBus } from '@makaio/bus-core';
import { CapabilitySubjects, type ICapabilityProvider } from '@makaio/contracts';

/** Capability id used for observed-session ingestion policy providers. */
export const OBSERVED_SESSION_INGESTION_POLICY_CAPABILITY_ID = 'observed-session-ingestion-policy';

/** Import lifecycle status a policy can choose for an observed session. */
export type ObservedSessionIngestionPolicyImportStatus = 'tracking' | 'discovered';

/** Decision returned by an observed-session ingestion policy provider. */
export interface ObservedSessionIngestionPolicyDecision {
  /** `tracking` imports transcript content; `discovered` registers metadata only. */
  readonly importStatus: ObservedSessionIngestionPolicyImportStatus;
}

/** Inputs available when deciding how an observed session should be ingested. */
export interface ObservedSessionIngestionPolicyInput {
  /** Stable client id that emitted the observation. */
  readonly clientId: string;
  /** Observation source, such as `native-hook` or `adapter-derived`. */
  readonly source: string;
  /** External session id reported by the client runtime. */
  readonly adapterSessionId: string;
  /** Canonical importer adapter name that would own content import. */
  readonly adapterName: string;
  /** Working directory observed at session start, when available. */
  readonly cwd?: string;
  /** Transcript path observed from the client runtime, when available. */
  readonly transcriptPath?: string;
}

/** Capability provider that decides observed-session content ingestion policy. */
export interface IObservedSessionIngestionPolicyProvider extends ICapabilityProvider {
  /**
   * Decide whether an observed session should content-import or metadata-register only.
   * @param input - Observed session identity and importer context
   * @returns Ingestion policy decision
   */
  decideObservedSessionIngestion(
    input: ObservedSessionIngestionPolicyInput,
  ): ObservedSessionIngestionPolicyDecision | Promise<ObservedSessionIngestionPolicyDecision>;
}

/**
 * Register an observed-session ingestion policy provider.
 * @param bus - Makaio bus instance
 * @param provider - Policy provider to register
 * @returns Promise that resolves after registration handlers have completed
 */
export function registerObservedSessionIngestionPolicyProvider(
  bus: IMakaioBus,
  provider: IObservedSessionIngestionPolicyProvider,
): Promise<void> {
  return bus.emit(CapabilitySubjects.register, {
    capabilityId: OBSERVED_SESSION_INGESTION_POLICY_CAPABILITY_ID,
    provider,
  });
}

/**
 * Unregister an observed-session ingestion policy provider.
 * @param bus - Makaio bus instance
 * @param providerId - Policy provider id to remove
 * @returns Promise that resolves after unregistration handlers have completed
 */
export function unregisterObservedSessionIngestionPolicyProvider(bus: IMakaioBus, providerId: string): Promise<void> {
  return bus.emit(CapabilitySubjects.unregister, {
    capabilityId: OBSERVED_SESSION_INGESTION_POLICY_CAPABILITY_ID,
    providerId,
  });
}
