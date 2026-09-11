import {
  artifactPatchInstructions,
  artifactPatchSegments,
  compileArtifactDataChecker,
  readArtifactTitle,
  type ArtifactDataCheck,
  type ArtifactDataIssue,
  type ArtifactKindRegistration,
  type ArtifactPatchError,
  type ArtifactPatchIssue,
  type ArtifactPatchRequest,
  type ArtifactPatchResponse,
  type ArtifactRef,
  type ArtifactRevision,
} from '@makaio/contracts';
import { ToolErrorCodes, toolError, toolSuccess, type ToolExecutionContext, type ToolResult } from '@makaio/tools-core';
import { applyArtifactPatch } from './patch-engine.js';

/** One new revision the host is asked to persist. */
export interface ArtifactPatchStoreRequest {
  /**
   * Exact revision the patch was applied to, payload included.
   *
   * The full revision travels rather than a reference so a host can derive the
   * change it observes — a status transition, an audit entry — from the two
   * payloads it has in hand, without a second read of a revision this package
   * already resolved.
   */
  readonly previous: ArtifactRevision;
  /** Patched payload, already validated against the effective kind schema. */
  readonly data: Record<string, unknown>;
  /**
   * Caller-owned status observation for this write, as a `data`-relative JSON
   * Pointer. Present exactly when the request named one; a host that emits
   * status events reads the pointer in `previous.data` and in the payload it
   * persists, exactly as a full revise does.
   */
  readonly statusPath?: string;
}

/** The artifact moved on before the write landed; nothing was persisted. */
export interface ArtifactPatchStoreConflict {
  /** Revision the artifact carries instead of `previous.revision`. */
  readonly conflictingRevision: string;
}

/** Either the persisted revision, or the conflict that stopped it. */
export type ArtifactPatchStoreResult = ArtifactRevision | ArtifactPatchStoreConflict;

/**
 * Recognize a store outcome that refused to overwrite a concurrent revision.
 * @param result - Outcome reported by the host.
 * @returns Whether the write was refused rather than performed.
 */
function isStoreConflict(result: ArtifactPatchStoreResult): result is ArtifactPatchStoreConflict {
  return 'conflictingRevision' in result;
}

/**
 * Host-owned access boundary for patch-based Artifact revisions.
 *
 * The host owns authorization, repository scope, effective Kind discovery, and
 * persistence. This package never issues raw Artifact bus requests and never
 * reaches a store directly, so the same patch engine serves an MCP process and
 * a service handling `artifact.patch` without either learning the other's
 * transport.
 */
export interface ArtifactPatchHost {
  /** List effective registrations for a requested Kind. */
  listKinds(kind: string, context: ToolExecutionContext): Promise<readonly ArtifactKindRegistration[]>;
  /**
   * Resolve the host-authorized current revision for one Kind and identity.
   *
   * The patch applies to this revision. Comparing its identifier with the
   * caller's `baseRevision` rejects a stale caller before any work and names
   * the current revision in the same step, so recovery never needs a re-read of
   * the payload. It is not the authoritative concurrency check — `store` is,
   * because two callers can pass this comparison at the same time.
   */
  resolveCurrent(
    ref: { readonly kind: string; readonly id: string },
    context: ToolExecutionContext,
  ): Promise<ArtifactRevision | null>;
  /**
   * Persist the patched payload as the next revision, or refuse the write.
   *
   * This is the authoritative half of the optimistic concurrency check and it
   * must be a compare-and-swap against `previous.revision`: the revision
   * comparison this package makes before applying the patch is an early, cheap
   * rejection, and two callers can pass it concurrently. A host that writes
   * without comparing `previous.revision` reintroduces the lost update this
   * contract exists to prevent.
   *
   * A thrown rejection is reported to the caller as an unknown outcome, because
   * this contract cannot tell a write that never ran from one that committed
   * before the failure surfaced. Refusing a write by returning
   * `ArtifactPatchStoreConflict` is the only outcome that promises nothing was
   * persisted.
   */
  store(request: ArtifactPatchStoreRequest, context: ToolExecutionContext): Promise<ArtifactPatchStoreResult>;
}

/**
 * Convert an unknown thrown value to a concise error message.
 * @param error - Thrown value.
 * @returns Human-readable message.
 */
function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Wrap a rejection in the response envelope.
 * @param error - Structured rejection.
 * @returns Failed patch response.
 */
function failed(error: ArtifactPatchError): ArtifactPatchResponse {
  return { ok: false, error };
}

/**
 * Build an immutable pointer to one revision.
 * @param kind - Artifact kind discriminator.
 * @param id - Stable artifact identity.
 * @param revision - Revision identifier.
 * @returns Artifact reference.
 */
function artifactRef(kind: string, id: string, revision: string): ArtifactRef {
  return { refClass: 'artifact', kind, id, revision };
}

/**
 * Copy one schema rejection into the mutable shape the wire contract declares.
 * @param issue - Rejection reported by the compiled kind schema.
 * @returns The same rejection as a response issue.
 */
function toResponseIssue(issue: ArtifactDataIssue): ArtifactPatchIssue {
  return {
    path: issue.path,
    reason: issue.reason,
    ...(issue.expectedType === undefined ? {} : { expectedType: issue.expectedType }),
    ...(issue.allowedValues === undefined ? {} : { allowedValues: [...issue.allowedValues] }),
  };
}

/**
 * Decide whether a patch can be resent unchanged against a newer revision.
 *
 * Only an append at a fixed path qualifies: `$push` adds an entry, so it means
 * the same thing whatever else landed in between — but only while every segment
 * of its path is a plain property. A position does not survive, because an entry
 * inserted ahead of `tasks.3` moves the target; and a `$[filter]` placeholder
 * does not either, because the concurrent revision may have changed the field
 * the filter compares or added another matching entry, so the resend would
 * append to a different set of collections than the caller addressed. Every
 * other operator depends on the payload the caller read: `$set` replaces a value
 * it has not seen since, and `$unset` and `$pull` delete state it has not
 * re-read, which the concurrent revision may have written for a reason.
 * @param input - The rejected patch request.
 * @returns Whether every instruction still means the same thing on a newer revision.
 */
function isRebasable(input: ArtifactPatchRequest): boolean {
  return artifactPatchInstructions(input.patch).every(
    ({ operator, path }) =>
      operator === '$push' && artifactPatchSegments(path).every((segment) => segment.kind === 'property'),
  );
}

/**
 * Report that the artifact advanced past the revision the patch was written against.
 * @param input - The rejected patch request.
 * @param currentRevision - Revision the artifact carries instead.
 * @returns Structured rejection naming the current revision and how to recover.
 */
function baseRevisionConflict(input: ArtifactPatchRequest, currentRevision: string): ArtifactPatchError {
  return {
    code: 'BASE_REVISION_CONFLICT',
    message: `Artifact '${input.ref.kind}:${input.ref.id}' has advanced to revision '${currentRevision}'.`,
    currentRevision,
    repair: isRebasable(input)
      ? `Resend the same patch with baseRevision '${currentRevision}'; it only appends at a fixed path, with no position and no filter, so it does not depend on the payload you read.`
      : `Re-read the artifact at revision '${currentRevision}' and rewrite the patch: only an append at a fixed path survives a concurrent write, with no position and no filter. Replacing, removing, addressing an entry by position, and appending through a $[filter] placeholder all depend on the payload you read, which the concurrent revision may have changed.`,
  };
}

/**
 * Summarize schema rejections into one actionable repair hint.
 * @param issues - Rejected locations reported by the kind schema.
 * @returns A hint naming the first rejection concretely.
 */
function repairHint(issues: readonly ArtifactDataIssue[]): string {
  const first = issues[0];
  if (!first) return 'Correct the patched result so it satisfies the kind schema.';
  const location = first.path === '' ? 'the payload root' : `'${first.path}'`;
  if (first.allowedValues) {
    const values = first.allowedValues.map((value) => (typeof value === 'string' ? value : JSON.stringify(value)));
    return `${location} accepts one of: ${values.join(', ')}.`;
  }
  if (first.expectedType) return `${location} expects type ${first.expectedType}.`;
  return `${location} ${first.reason}.`;
}

/**
 * Enforce the nonblank-title invariant on a patched payload.
 *
 * The compiled checker covers the serialized data schema only, and a kind may
 * declare its title path on a plain `{ type: 'string' }`. The invariant
 * therefore lives outside that schema, where every other writer enforces it
 * after validation; a patched result that blanks the title has to be rejected
 * here or it becomes a revision no reader can title.
 * @param data - Patched payload that already satisfies the kind schema.
 * @param registration - Effective registration declaring the title path.
 * @returns A rejection, or undefined when the payload still carries a title.
 */
function checkTitle(
  data: Record<string, unknown>,
  registration: ArtifactKindRegistration,
): ArtifactPatchError | undefined {
  try {
    readArtifactTitle(data, registration.titlePath);
    return undefined;
  } catch (error) {
    return {
      code: 'SCHEMA_VALIDATION_FAILED',
      message: `The patched result does not satisfy the '${registration.kind}' data schema.`,
      issues: [{ path: registration.titlePath, reason: failureMessage(error) }],
      repair: `'${registration.titlePath}' must be a nonblank string.`,
    };
  }
}

/**
 * Resolve the registration matching the stored revision's schema version.
 * @param registrations - Effective registrations reported by the host.
 * @param artifact - Revision the patch applies to.
 * @returns The matching registration, or the rejection explaining its absence.
 */
function resolveRegistration(
  registrations: readonly ArtifactKindRegistration[],
  artifact: ArtifactRevision,
): ArtifactKindRegistration | ArtifactPatchError {
  const candidates = registrations.filter((candidate) => candidate.kind === artifact.kind);
  if (candidates.length === 0) {
    return {
      code: 'KIND_NOT_REGISTERED',
      message: `Artifact kind '${artifact.kind}' is not registered.`,
      repair: 'Register the kind, or address an artifact of a registered kind.',
    };
  }
  const registration = candidates.find((candidate) => candidate.schemaVersion === artifact.schemaVersion);
  if (!registration) {
    return {
      code: 'SCHEMA_VERSION_MISMATCH',
      message: `Revision '${artifact.revision}' uses schema version ${artifact.schemaVersion}, for which '${artifact.kind}' has no registration.`,
      repair: `Register '${artifact.kind}' at schema version ${artifact.schemaVersion}, or migrate the artifact before patching it.`,
    };
  }
  return registration;
}

/**
 * Load the revision a patch applies to, enforcing the caller's base revision.
 * @param input - Validated patch request.
 * @param context - Tool execution context forwarded to the host.
 * @param host - Host-owned access boundary.
 * @returns The base revision, or the rejection explaining why it is unusable.
 */
async function loadBaseRevision(
  input: ArtifactPatchRequest,
  context: ToolExecutionContext,
  host: ArtifactPatchHost,
): Promise<ArtifactRevision | ArtifactPatchError> {
  let artifact: ArtifactRevision | null;
  try {
    artifact = await host.resolveCurrent({ kind: input.ref.kind, id: input.ref.id }, context);
  } catch (error) {
    return {
      code: 'HOST_FAILED',
      message: `Artifact lookup failed: ${failureMessage(error)}`,
      repair: 'Retry once the artifact store is reachable.',
    };
  }
  if (!artifact) {
    return {
      code: 'ARTIFACT_NOT_FOUND',
      message: `Artifact '${input.ref.kind}:${input.ref.id}' was not found.`,
      repair: 'Check the kind and identity, or create the artifact before revising it.',
    };
  }
  if (artifact.kind !== input.ref.kind || artifact.id !== input.ref.id) {
    return {
      code: 'HOST_FAILED',
      message: 'Artifact lookup returned a different artifact identity.',
      repair: 'Retry; the resolved artifact did not match the requested identity.',
    };
  }
  if (artifact.revision !== input.baseRevision) return baseRevisionConflict(input, artifact.revision);
  return artifact;
}

/**
 * Revise one artifact by applying a patch to its current revision.
 *
 * The patch is applied to a copy of the stored payload, the complete result is
 * validated against the effective kind schema, and only then is a new revision
 * written. A dry run stops before the write and returns the same diagnostics,
 * so a caller can prove a patch without producing history.
 *
 * This function is the whole operation behind the `artifact.patch` subject; a
 * host serving that subject and the MCP facade run exactly the same code.
 * @param input - Validated patch request.
 * @param context - Tool execution context forwarded to the host.
 * @param host - Host-owned access boundary.
 * @returns The applied patch, or the rejection that stopped it.
 */
export async function patchArtifact(
  input: ArtifactPatchRequest,
  context: ToolExecutionContext,
  host: ArtifactPatchHost,
): Promise<ArtifactPatchResponse> {
  const artifact = await loadBaseRevision(input, context, host);
  if ('code' in artifact) return failed(artifact);
  const base = artifactRef(artifact.kind, artifact.id, artifact.revision);

  let registrations: readonly ArtifactKindRegistration[];
  try {
    registrations = await host.listKinds(input.ref.kind, context);
  } catch (error) {
    return failed({
      code: 'HOST_FAILED',
      message: `Artifact kind lookup failed: ${failureMessage(error)}`,
      repair: 'Retry once the kind catalog is reachable.',
    });
  }
  const registration = resolveRegistration(registrations, artifact);
  if ('code' in registration) return failed(registration);

  const applied = applyArtifactPatch(artifact.data, input.patch, registration.dataSchema);
  if (!applied.ok) return failed(applied.error);

  let check: ArtifactDataCheck;
  try {
    check = compileArtifactDataChecker(registration)(applied.application.data);
  } catch (error) {
    return failed({
      code: 'HOST_FAILED',
      message: `Artifact kind '${registration.kind}' could not compile its data schema: ${failureMessage(error)}`,
      repair: 'Correct the registered data schema before patching artifacts of this kind.',
    });
  }
  if (!check.valid) {
    return failed({
      code: 'SCHEMA_VALIDATION_FAILED',
      message: `The patched result does not satisfy the '${registration.kind}' data schema.`,
      issues: check.issues.map(toResponseIssue),
      repair: repairHint(check.issues),
    });
  }

  const blankTitle = checkTitle(applied.application.data, registration);
  if (blankTitle) return failed(blankTitle);

  const operations = [...applied.application.operations];
  if (input.dryRun === true) return { ok: true, base, dryRun: true, operations };

  let stored: ArtifactPatchStoreResult;
  try {
    stored = await host.store(
      {
        previous: artifact,
        data: applied.application.data,
        ...(input.statusPath === undefined ? {} : { statusPath: input.statusPath }),
      },
      context,
    );
  } catch (error) {
    // The store contract promises a compare-and-swap against `previous.revision`;
    // it says nothing about what a throw means, so a write that committed before
    // the failure surfaced is indistinguishable from one that never ran. The
    // repair therefore cannot offer a plain retry: resending an append would
    // add the entry twice.
    return failed({
      code: 'HOST_FAILED',
      message: `Artifact revision failed: ${failureMessage(error)}`,
      repair:
        'Re-read the artifact: the write may have been committed before the failure was reported. Retry only after confirming the change is absent.',
    });
  }
  if (isStoreConflict(stored)) return failed(baseRevisionConflict(input, stored.conflictingRevision));
  if (stored.kind !== base.kind || stored.id !== base.id || stored.revision === base.revision) {
    return failed({
      code: 'HOST_FAILED',
      message: 'The store returned an artifact that is not a new revision of the patched one.',
      repair: 'Re-read the artifact before patching it again; the write outcome is unclear.',
    });
  }
  return {
    ok: true,
    base,
    dryRun: false,
    artifact: artifactRef(stored.kind, stored.id, stored.revision),
    operations,
  };
}

/**
 * Revise one artifact by patch through an explicit host-owned access boundary.
 *
 * Rejections that the caller can act on are returned in band as part of the
 * contract's response, because the repair hint is the point. Only an absent
 * host is a tool-level failure: without one there is nothing to authorize the
 * write, so the request fails closed before any lookup.
 * @param input - Validated patch request.
 * @param context - Tool execution context supplied by the host.
 * @param host - Optional authorized host boundary.
 * @returns The patch outcome, or a whole-tool failure when no host is bound.
 */
export async function executePatchArtifact(
  input: ArtifactPatchRequest,
  context: ToolExecutionContext,
  host?: ArtifactPatchHost,
): Promise<ToolResult<ArtifactPatchResponse>> {
  if (!host) {
    return toolError(ToolErrorCodes.PERMISSION_DENIED, 'Artifact revisions require an authorized host.');
  }
  return toolSuccess(await patchArtifact(input, context, host));
}
