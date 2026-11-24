import { randomBytes } from 'node:crypto';
import {
  captureHmacIdentitySecretCleanup,
  registerHmacIdentitySecret,
  resolveHmacIdentityParty,
  resolveHmacIdentitySecret,
  rotateHmacIdentitySecret,
} from '@makaio/bus-transport-websocket';
import { getFullSubjectForSubjectDefinition, MAKAIO_JOB_RUN_PARTY_KIND, type CallClaim } from '@makaio/core';
import { AdapterSubsystemSubjects } from '@makaio/services-core/adapter-subsystem';
import { WorkflowStorageSubjects } from '@makaio/subsystem-workflow-engine';
import { ArtifactSubjects, SubagentSubjects, WorkerSubjects, WorkflowSubjects } from '@makaio/contracts';

/** Registered per-identity HMAC secret and cleanup handle. */
export interface WorkflowExecutionBusSecret {
  /** Secret sent to the workflow worker over its provider bootstrap channel. */
  readonly secret: string;
  /** Cleanup function that unregisters this exact identity secret. */
  readonly cleanup: () => void;
}

/** Parameters for minting a workflow execution bus secret. */
export interface MintWorkflowExecutionBusSecretParams {
  /** Opaque key of the transport identity in the secret registry. */
  readonly identityId: string;
  /**
   * Parent workflow execution identifier attached as a claim on the
   * authenticated party context.
   *
   * Bus handlers read `party.claims.executionId` to verify execution-bound
   * access without parsing the identity ID.
   */
  readonly executionId: string;
  /** Optional host-owned claims for an execution protocol. */
  readonly protocolClaims?: Readonly<Record<string, CallClaim>>;
  /**
   * Optional outbound message restriction list for this workflow execution.
   *
   * When omitted, the default message subjects from
   * {@link buildWorkflowExecutionSubjectAccess} are used.
   */
  readonly allowedMessageSubjects?: readonly string[];
  /**
   * Optional subscription restriction list for this workflow execution.
   *
   * When omitted, the default subscription subjects from
   * {@link buildWorkflowExecutionSubjectAccess} are used. Server-to-peer
   * request routing still requires a matching advertised subscription.
   */
  readonly allowedSubscriptionSubjects?: readonly string[];
  /** Extra filters a subscription must carry, keyed by full subject. */
  readonly requiredSubscriptionFilters?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/** Parameters for registering a caller-provided workflow execution bus secret. */
export interface RegisterWorkflowExecutionBusSecretParams extends MintWorkflowExecutionBusSecretParams {
  /** Secret already provisioned through the execution provider's bootstrap channel. */
  readonly secret: string;
}

/** Parameters for rotating an existing workflow execution bus secret. */
export interface RotateWorkflowExecutionBusSecretParams {
  /** Opaque key of the existing transport identity. */
  readonly identityId: string;
  /** Parent workflow execution identifier that must match the registered claim. */
  readonly executionId: string;
  /** Optional host-owned claims for an execution protocol. */
  readonly protocolClaims?: Readonly<Record<string, CallClaim>>;
}

// ---------------------------------------------------------------------------
// Static subject lists for workflow execution identities
// ---------------------------------------------------------------------------

/** Static outbound execution subjects derived from their canonical definitions. */
const STATIC_EXECUTION_MESSAGE_SUBJECTS = [
  WorkerSubjects.runtime.inputs.get,
  WorkerSubjects.control.outcome.submit,
  WorkflowSubjects.getRunContext,
  AdapterSubsystemSubjects.listAdapters,
  WorkflowSubjects.finalizeDelegateResult,
  WorkflowStorageSubjects.getExecution,
  WorkflowStorageSubjects.setFrame,
  WorkflowStorageSubjects.setSpan,
  WorkflowStorageSubjects.listFrames,
  WorkflowSubjects.frame.started,
  WorkflowSubjects.frame.completed,
  WorkflowSubjects.frame.failed,
  WorkflowSubjects.frame.sessionLinked,
  WorkflowSubjects.state.get,
  WorkflowSubjects.state.patch,
  WorkflowSubjects.resolveRole,
  ArtifactSubjects.kind.list,
  ArtifactSubjects.query,
  ArtifactSubjects.resolve,
  ArtifactSubjects.resolvePart,
  ArtifactSubjects.create,
  ArtifactSubjects.revise,
  ArtifactSubjects.patch,
  SubagentSubjects.spawn,
  SubagentSubjects.await,
  SubagentSubjects.getStatus,
  SubagentSubjects.kill,
] as const;

/** Directional subject restrictions for a workflow execution identity. */
export interface WorkflowExecutionSubjectAccess {
  /** Subjects the identity may send to the authority. */
  readonly allowedMessageSubjects: readonly string[];
  /** Subjects the identity may advertise to receive from the authority. */
  readonly allowedSubscriptionSubjects: readonly string[];
}

/**
 * Build the default directional restrictions of a remote workflow execution.
 * Host protocols can add their own rights before minting the identity.
 * @param executionId - Workflow execution identifier for the cancel subject.
 * @returns Default allowed message and subscription subjects for the execution.
 */
export function buildWorkflowExecutionSubjectAccess(executionId: string): WorkflowExecutionSubjectAccess {
  return {
    allowedMessageSubjects: STATIC_EXECUTION_MESSAGE_SUBJECTS.map(getFullSubjectForSubjectDefinition),
    allowedSubscriptionSubjects: [`workflow.${executionId}.cancel`],
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
 * Register caller-provided bus access for one workflow execution.
 *
 * Use this when a provider already owns secret delivery. The identity still
 * receives the canonical job run party kind, claim, and directional subject
 * restrictions.
 * @param params - Transport identity, execution claim, secret, and optional directional restrictions.
 * @returns Registered secret plus cleanup handle.
 */
export function registerWorkflowExecutionBusSecret(
  params: RegisterWorkflowExecutionBusSecretParams,
): WorkflowExecutionBusSecret {
  assertNoRetiredAllowedSubjects(params);
  const { identityId, executionId, secret } = params;
  const defaultAccess = buildWorkflowExecutionSubjectAccess(executionId);
  return {
    secret,
    cleanup: registerHmacIdentitySecret(identityId, secret, {
      partyKind: MAKAIO_JOB_RUN_PARTY_KIND,
      attestingRole: 'job-run',
      claims: { ...params.protocolClaims, executionId },
      allowedMessageSubjects: params.allowedMessageSubjects ?? defaultAccess.allowedMessageSubjects,
      allowedSubscriptionSubjects: params.allowedSubscriptionSubjects ?? defaultAccess.allowedSubscriptionSubjects,
      requiredSubscriptionFilters: params.requiredSubscriptionFilters,
    }),
  };
}

/**
 * Mint and register an identity-bound HMAC secret for one workflow execution.
 *
 * The identity is keyed by `identityId` with the job run party kind
 * `MAKAIO_JOB_RUN_PARTY_KIND`. The parent `executionId` is attached as a
 * claim so bus handlers can verify execution-bound access via
 * `party.claims.executionId`.
 *
 * When directional restrictions are not provided, the default matrix from
 * {@link buildWorkflowExecutionSubjectAccess} restricts the identity to the
 * minimum outbound and subscription subjects a worker needs.
 * @param params - Transport identity and execution identifiers.
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
 * Rotate the HMAC secret for an already-registered workflow execution identity.
 *
 * Used by the bootstrap authorizer on repeat claims: the workflow identity
 * already has a registered secret from the first claim, so the new claim
 * rotates the secret and fences any socket authenticated with the old one.
 *
 * Rotation preserves the existing party metadata, so the registered identity
 * must already be a job run bound to the same execution.
 * @param params - Transport identity and execution identifiers.
 * @returns Secret plus cleanup handle.
 * @throws When no matching workflow execution registration exists.
 */
export function rotateWorkflowExecutionBusSecret(
  params: RotateWorkflowExecutionBusSecretParams,
): WorkflowExecutionBusSecret {
  const { identityId, executionId } = params;
  const party = resolveHmacIdentityParty(identityId);
  if (party?.kind !== MAKAIO_JOB_RUN_PARTY_KIND || party.claims?.executionId !== executionId) {
    throw new Error(
      `Cannot rotate workflow execution bus secret: identity "${identityId}" is not registered for execution "${executionId}"`,
    );
  }
  const secret = randomBytes(32).toString('hex');
  return {
    secret,
    cleanup: rotateHmacIdentitySecret(
      identityId,
      secret,
      params.protocolClaims === undefined
        ? undefined
        : { claims: { ...party.claims, ...params.protocolClaims, executionId } },
    ),
  };
}

/**
 * Mint or rotate a workflow execution bus secret.
 *
 * First claim for a given `identityId` mints a new registration.
 * Repeat claims rotate the existing registration, fencing any socket that
 * authenticated under the previous secret.
 * @param params - Transport identity and execution identifiers.
 * @returns Secret plus cleanup handle.
 */
export function mintOrRotateWorkflowExecutionBusSecret(
  params: MintWorkflowExecutionBusSecretParams,
): WorkflowExecutionBusSecret {
  assertNoRetiredAllowedSubjects(params);
  const existing = resolveHmacIdentitySecret(params.identityId);
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
 * An unknown identity has nothing to clean up. A registered identity for a
 * different party kind or execution is refused rather than being revoked.
 * @param params - Transport identity and execution identifiers that must match the registration.
 * @returns A generation-fenced cleanup handle, or undefined when unregistered.
 * @throws When the registered identity is not bound to this workflow execution.
 */
export function captureWorkflowExecutionBusSecretCleanup(
  params: RotateWorkflowExecutionBusSecretParams,
): (() => void) | undefined {
  const { identityId, executionId } = params;
  const party = resolveHmacIdentityParty(identityId);
  if (party === null) {
    return undefined;
  }
  if (party.kind !== MAKAIO_JOB_RUN_PARTY_KIND || party.claims?.executionId !== executionId) {
    throw new Error(
      `Cannot capture workflow execution bus secret cleanup: identity "${identityId}" is not registered for execution "${executionId}"`,
    );
  }
  return captureHmacIdentitySecretCleanup(identityId);
}

/**
 * Resolve a registered workflow execution HMAC secret by identity ID.
 * @param identityId - Transport identity.
 * @returns Secret, or undefined when no secret is registered for this identity.
 */
export function resolveWorkflowExecutionBusSecret(identityId: string): string | undefined {
  return resolveHmacIdentitySecret(identityId) ?? undefined;
}
