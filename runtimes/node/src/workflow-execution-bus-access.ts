import { randomBytes } from 'node:crypto';
import {
  captureHmacIdentitySecretCleanup,
  registerHmacIdentitySecret,
  resolveHmacIdentityPeer,
  resolveHmacIdentitySecret,
  rotateHmacIdentitySecret,
} from '@makaio/bus-transport-websocket';
import { getFullSubjectForSubjectDefinition } from '@makaio/core';
import { AdapterSubsystemSubjects } from '@makaio/services-core/adapter-subsystem';
import { WorkflowStorageSubjects } from '@makaio/subsystem-workflow-engine';
import {
  ArtifactSubjects,
  ExecutionAttemptSubjects,
  SubagentSubjects,
  WorkerSubjects,
  WorkflowSubjects,
} from '@makaio/contracts';

/** Registered per-attempt HMAC secret and cleanup handle. */
export interface WorkflowExecutionBusSecret {
  /** Secret sent to the workflow worker over its provider bootstrap channel. */
  readonly secret: string;
  /** Cleanup function that unregisters this exact identity secret. */
  readonly cleanup: () => void;
}

/** Parameters for minting a workflow execution bus secret. */
export interface MintWorkflowExecutionBusSecretParams {
  /**
   * Authority-created attempt identifier used as the transport identity ID.
   *
   * Each dispatch attempt gets its own identity; revoking one attempt does
   * not affect other attempts of the same execution.
   */
  readonly executionAttemptId: string;
  /**
   * Parent workflow execution identifier attached as a claim on the
   * authenticated peer context.
   *
   * Bus handlers read `peer.claims.executionId` to verify execution-bound
   * access without parsing the identity ID.
   */
  readonly executionId: string;
  /**
   * Optional subject restriction list for this execution attempt.
   *
   * The transport accepts only matching messages and subscription
   * advertisements from the peer. Server-to-peer request routing still
   * requires a matching advertised subscription. When omitted, the default
   * list from {@link buildExecutionAttemptAllowedSubjects} is used.
   */
  readonly allowedSubjects?: readonly string[];
}

/** Parameters for registering a caller-provided workflow execution bus secret. */
export interface RegisterWorkflowExecutionBusSecretParams extends MintWorkflowExecutionBusSecretParams {
  /** Secret already provisioned through the execution provider's bootstrap channel. */
  readonly secret: string;
}

/** Parameters for rotating an existing workflow execution bus secret. */
export interface RotateWorkflowExecutionBusSecretParams {
  /** Authority-created attempt identifier used as the transport identity ID. */
  readonly executionAttemptId: string;
  /** Parent workflow execution identifier that must match the registered claim. */
  readonly executionId: string;
}

// ---------------------------------------------------------------------------
// Static subject lists for execution-attempt identities
// ---------------------------------------------------------------------------

/** Static execution subjects derived from their canonical definitions. */
const STATIC_EXECUTION_SUBJECTS = [
  ExecutionAttemptSubjects.runtime.register,
  ExecutionAttemptSubjects.bootstrap.awaitStart,
  ExecutionAttemptSubjects.instruction.get,
  ExecutionAttemptSubjects.operation.admit,
  ExecutionAttemptSubjects.operation.report,
  ExecutionAttemptSubjects.operation.deliver,
  ExecutionAttemptSubjects.outcome.submit,
  WorkerSubjects.runtime.inputs.get,
  WorkerSubjects.control.outcome.submit,
  WorkflowSubjects.getRunContext,
  AdapterSubsystemSubjects.listAdapters,
  WorkflowSubjects.bootstrapAuthorityState,
  WorkflowSubjects.finalizeDelegateResult,
  WorkflowStorageSubjects.getExecution,
  WorkflowStorageSubjects.setFrame,
  WorkflowStorageSubjects.setSpan,
  WorkflowStorageSubjects.listFrames,
  WorkflowStorageSubjects.getGateInstance,
  WorkflowStorageSubjects.setGateInstance,
  WorkflowSubjects.frame.started,
  WorkflowSubjects.frame.completed,
  WorkflowSubjects.frame.failed,
  WorkflowSubjects.frame.sessionLinked,
  WorkflowSubjects.execution.progress,
  WorkflowSubjects.gate.suspended,
  WorkflowSubjects.gate.resumed,
  WorkflowSubjects.gate.resolved,
  WorkflowSubjects.gate.respond,
  WorkflowSubjects.state.get,
  WorkflowSubjects.state.patch,
  WorkflowSubjects.resolveAgent,
  WorkflowSubjects.resolveRole,
  ArtifactSubjects.query,
  ArtifactSubjects.create,
  ArtifactSubjects.revise,
  WorkflowSubjects.artifact.updated,
  SubagentSubjects.spawn,
  SubagentSubjects.await,
  SubagentSubjects.getStatus,
  SubagentSubjects.kill,
] as const;

/**
 * Build the complete allowed-subjects list for a workflow execution attempt.
 *
 * The returned list includes all static subjects that any execution attempt
 * may need, plus the dynamic per-execution cancel subject. Subjects are
 * statically enumerable even when the workflow content does not use every
 * feature (e.g. state, delegation, artifacts, subagents) because the
 * transport restriction is deny-by-default: listing a subject that the
 * workflow never uses has no security impact. Delegate result finalization is
 * routed through the static Authority gateway; dynamic finalizer subjects are
 * never exposed to remote attempts.
 * @param executionId - Workflow execution identifier for the dynamic cancel subject.
 * @returns Complete allowed-subjects list for the execution attempt.
 */
export function buildExecutionAttemptAllowedSubjects(executionId: string): readonly string[] {
  return [...STATIC_EXECUTION_SUBJECTS.map(getFullSubjectForSubjectDefinition), `workflow.${executionId}.cancel`];
}

/**
 * Register caller-provided bus access for one workflow execution attempt.
 *
 * Use this when a provider already owns secret delivery. The identity still
 * receives the canonical execution peer kind, claim, and subject restriction.
 * @param params - Attempt identity, execution claim, secret, and optional subject restriction.
 * @returns Registered secret plus cleanup handle.
 */
export function registerWorkflowExecutionBusSecret(
  params: RegisterWorkflowExecutionBusSecretParams,
): WorkflowExecutionBusSecret {
  const { executionAttemptId, executionId, secret } = params;
  const allowedSubjects = params.allowedSubjects ?? buildExecutionAttemptAllowedSubjects(executionId);
  return {
    secret,
    cleanup: registerHmacIdentitySecret(executionAttemptId, secret, {
      peerKind: 'workflow-execution-attempt',
      claims: { executionId },
      allowedSubjects,
    }),
  };
}

/**
 * Mint and register an identity-bound HMAC secret for one workflow execution attempt.
 *
 * The identity is keyed by `executionAttemptId` with peer kind
 * `workflow-execution-attempt`. The parent `executionId` is attached as a
 * claim so bus handlers can verify execution-bound access via
 * `peer.claims.executionId`.
 *
 * When `params.allowedSubjects` is not provided, the default allowed-subjects
 * list from {@link buildExecutionAttemptAllowedSubjects} is used to restrict
 * the identity to the minimum set of bus subjects a worker needs.
 * @param params - Attempt and execution identifiers.
 * @returns Secret plus cleanup handle.
 */
export function mintWorkflowExecutionBusSecret(
  params: MintWorkflowExecutionBusSecretParams,
): WorkflowExecutionBusSecret {
  const secret = randomBytes(32).toString('hex');
  return registerWorkflowExecutionBusSecret({ ...params, secret });
}

/**
 * Rotate the HMAC secret for an already-registered workflow execution attempt.
 *
 * Used by the bootstrap authorizer on repeat claims: the attempt identity
 * already has a registered secret from the first claim, so the new claim
 * rotates the secret and fences any socket authenticated with the old one.
 *
 * Rotation preserves the existing peer metadata, so the registered identity
 * must already be a workflow execution attempt bound to the same execution.
 * @param params - Attempt and execution identifiers.
 * @returns Secret plus cleanup handle.
 * @throws When no matching execution-attempt registration exists.
 */
export function rotateWorkflowExecutionBusSecret(
  params: RotateWorkflowExecutionBusSecretParams,
): WorkflowExecutionBusSecret {
  const { executionAttemptId, executionId } = params;
  const peer = resolveHmacIdentityPeer(executionAttemptId);
  if (peer?.kind !== 'workflow-execution-attempt' || peer.claims?.executionId !== executionId) {
    throw new Error(
      `Cannot rotate workflow execution bus secret: attempt "${executionAttemptId}" is not registered for execution "${executionId}"`,
    );
  }
  const secret = randomBytes(32).toString('hex');
  return {
    secret,
    cleanup: rotateHmacIdentitySecret(executionAttemptId, secret),
  };
}

/**
 * Mint or rotate a workflow execution bus secret.
 *
 * First claim for a given `executionAttemptId` mints a new registration.
 * Repeat claims rotate the existing registration, fencing any socket that
 * authenticated under the previous secret.
 * @param params - Attempt and execution identifiers.
 * @returns Secret plus cleanup handle.
 */
export function mintOrRotateWorkflowExecutionBusSecret(
  params: MintWorkflowExecutionBusSecretParams,
): WorkflowExecutionBusSecret {
  const existing = resolveHmacIdentitySecret(params.executionAttemptId);
  if (existing !== null) {
    return rotateWorkflowExecutionBusSecret(params);
  }
  return mintWorkflowExecutionBusSecret(params);
}

/**
 * Capture a cleanup handle for the current workflow-execution bus identity.
 *
 * Service recomposition can lose an older registration's original cleanup
 * closure while the process-global registry remains live. This captures the
 * current generation without exposing its secret. A later rotation remains
 * intact if the captured cleanup is invoked afterwards.
 *
 * An unknown attempt has nothing to clean up. A registered identity for a
 * different peer kind or execution is refused rather than being revoked.
 * @param params - Attempt and execution identifiers that must match the registration.
 * @returns A generation-fenced cleanup handle, or undefined when unregistered.
 * @throws When the registered identity is not this workflow execution attempt.
 */
export function captureWorkflowExecutionBusSecretCleanup(
  params: RotateWorkflowExecutionBusSecretParams,
): (() => void) | undefined {
  const { executionAttemptId, executionId } = params;
  const peer = resolveHmacIdentityPeer(executionAttemptId);
  if (peer === null) {
    return undefined;
  }
  if (peer.kind !== 'workflow-execution-attempt' || peer.claims?.executionId !== executionId) {
    throw new Error(
      `Cannot capture workflow execution bus secret cleanup: attempt "${executionAttemptId}" is not registered for execution "${executionId}"`,
    );
  }
  return captureHmacIdentitySecretCleanup(executionAttemptId);
}

/**
 * Resolve a registered workflow execution HMAC secret by attempt ID.
 * @param executionAttemptId - Execution attempt identity.
 * @returns Secret, or undefined when no secret is registered for this attempt.
 */
export function resolveWorkflowExecutionBusSecret(executionAttemptId: string): string | undefined {
  return resolveHmacIdentitySecret(executionAttemptId) ?? undefined;
}
