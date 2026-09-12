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
   * Optional outbound message restriction list for this execution attempt.
   *
   * When omitted, the default message subjects from
   * {@link buildExecutionAttemptSubjectAccess} are used.
   */
  readonly allowedMessageSubjects?: readonly string[];
  /**
   * Optional subscription restriction list for this execution attempt.
   *
   * When omitted, the default subscription subjects from
   * {@link buildExecutionAttemptSubjectAccess} are used. Server-to-peer
   * request routing still requires a matching advertised subscription.
   */
  readonly allowedSubscriptionSubjects?: readonly string[];
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

/** Static outbound execution subjects derived from their canonical definitions. */
const STATIC_EXECUTION_MESSAGE_SUBJECTS = [
  ExecutionAttemptSubjects.runtime.register,
  ExecutionAttemptSubjects.bootstrap.awaitStart,
  ExecutionAttemptSubjects.instruction.get,
  ExecutionAttemptSubjects.operation.admit,
  ExecutionAttemptSubjects.operation.report,
  ExecutionAttemptSubjects.outcome.submit,
  ExecutionAttemptSubjects.control.report,
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
  WorkflowSubjects.state.get,
  WorkflowSubjects.state.patch,
  WorkflowSubjects.resolveAgent,
  WorkflowSubjects.resolveRole,
  ArtifactSubjects.kind.list,
  ArtifactSubjects.query,
  ArtifactSubjects.resolve,
  ArtifactSubjects.resolvePart,
  ArtifactSubjects.create,
  ArtifactSubjects.revise,
  ArtifactSubjects.patch,
  WorkflowSubjects.artifact.updated,
  SubagentSubjects.spawn,
  SubagentSubjects.await,
  SubagentSubjects.getStatus,
  SubagentSubjects.kill,
] as const;

/** Static inbound endpoint subjects execution attempts may advertise. */
const STATIC_EXECUTION_SUBSCRIPTION_SUBJECTS = [
  ExecutionAttemptSubjects.operation.deliver,
  ExecutionAttemptSubjects.control.deliver,
  WorkflowSubjects.gate.respond,
] as const;

/** Directional subject restrictions for an execution-attempt identity. */
export interface ExecutionAttemptSubjectAccess {
  /** Subjects the attempt may send to the authority. */
  readonly allowedMessageSubjects: readonly string[];
  /** Subjects the attempt may advertise to receive from the authority. */
  readonly allowedSubscriptionSubjects: readonly string[];
}

/**
 * Build the complete directional subject restrictions for a workflow execution
 * attempt.
 *
 * Message subjects include every static operation an attempt may originate.
 * Subscription subjects include only the authority-delivered operation,
 * control, and gate-response endpoints plus the dynamic per-execution
 * cancellation endpoint.
 * Subjects are statically enumerable even when the workflow content does not
 * use every feature (e.g. state, delegation, artifacts, subagents) because
 * the transport restriction is deny-by-default: listing a subject that the
 * workflow never uses has no security impact. Delegate result finalization is
 * routed through the static Authority gateway; dynamic finalizer subjects are
 * never exposed to remote attempts.
 * @param executionId - Workflow execution identifier for the dynamic cancel subject.
 * @returns Complete directional subject restrictions for the execution attempt.
 */
export function buildExecutionAttemptSubjectAccess(executionId: string): ExecutionAttemptSubjectAccess {
  return {
    allowedMessageSubjects: STATIC_EXECUTION_MESSAGE_SUBJECTS.map(getFullSubjectForSubjectDefinition),
    allowedSubscriptionSubjects: [
      ...STATIC_EXECUTION_SUBSCRIPTION_SUBJECTS.map(getFullSubjectForSubjectDefinition),
      `workflow.${executionId}.cancel`,
    ],
  };
}

/**
 * Reject the retired flat access property before a public helper applies
 * directional defaults or rotates an existing identity.
 * @param params - Runtime-shaped public helper parameters to validate.
 */
function assertNoRetiredAllowedSubjects(params: object): void {
  if ('allowedSubjects' in params) {
    throw new Error(
      'Workflow execution bus access no longer accepts allowedSubjects; use allowedMessageSubjects and/or allowedSubscriptionSubjects',
    );
  }
}

/**
 * Register caller-provided bus access for one workflow execution attempt.
 *
 * Use this when a provider already owns secret delivery. The identity still
 * receives the canonical execution peer kind, claim, and directional subject
 * restrictions.
 * @param params - Attempt identity, execution claim, secret, and optional directional restrictions.
 * @returns Registered secret plus cleanup handle.
 */
export function registerWorkflowExecutionBusSecret(
  params: RegisterWorkflowExecutionBusSecretParams,
): WorkflowExecutionBusSecret {
  assertNoRetiredAllowedSubjects(params);
  const { executionAttemptId, executionId, secret } = params;
  const defaultAccess = buildExecutionAttemptSubjectAccess(executionId);
  return {
    secret,
    cleanup: registerHmacIdentitySecret(executionAttemptId, secret, {
      peerKind: 'workflow-execution-attempt',
      claims: { executionId },
      allowedMessageSubjects: params.allowedMessageSubjects ?? defaultAccess.allowedMessageSubjects,
      allowedSubscriptionSubjects: params.allowedSubscriptionSubjects ?? defaultAccess.allowedSubscriptionSubjects,
      requiredSubscriptionFilters: {
        [getFullSubjectForSubjectDefinition(ExecutionAttemptSubjects.operation.deliver)]: { executionAttemptId },
        [getFullSubjectForSubjectDefinition(ExecutionAttemptSubjects.control.deliver)]: { executionAttemptId },
        [getFullSubjectForSubjectDefinition(WorkflowSubjects.gate.respond)]: { executionAttemptId },
      },
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
 * When directional restrictions are not provided, the default matrix from
 * {@link buildExecutionAttemptSubjectAccess} restricts the identity to the
 * minimum outbound and subscription subjects a worker needs.
 * @param params - Attempt and execution identifiers.
 * @returns Secret plus cleanup handle.
 */
export function mintWorkflowExecutionBusSecret(
  params: MintWorkflowExecutionBusSecretParams,
): WorkflowExecutionBusSecret {
  assertNoRetiredAllowedSubjects(params);
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
  assertNoRetiredAllowedSubjects(params);
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
