import {
  ArtifactPatchIssueSchema,
  artifactPatchInstructions,
  artifactPatchSegments,
  compileArtifactDataChecker,
  readArtifactTitle,
  type ArtifactDataChecker,
  type ArtifactDataIssue,
  type ArtifactKindRegistration,
  type ArtifactPatchError,
  type ArtifactPatchIssue,
  type ArtifactPatchRequest,
  type ArtifactPatchResponse,
  type ArtifactRef,
  type ArtifactRepresentations,
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
   * Schema version the new revision is stored at.
   *
   * This is the version of the registration `data` was validated against: the
   * request's target when it named one, else `previous.schemaVersion`. A host
   * must persist the revision at this version rather than copying the previous
   * one, or a migration would be validated against the new shape and stored
   * under the old label.
   */
  readonly schemaVersion: number;
  /**
   * Caller-owned status observation for this write, as a `data`-relative JSON
   * Pointer. Present exactly when the request named one; a host that emits
   * status events reads the pointer in `previous.data` and in the payload it
   * persists, exactly as a full revise does.
   */
  readonly statusPath?: string;
  /**
   * Rendering hints for the new revision, present exactly when the request
   * named them. An object replaces the previous revision's hints wholesale and
   * `null` clears them; when the property is absent the host carries
   * `previous.representations` over unchanged, because hints are caller-owned
   * and the patch engine cannot tell whether the change made them stale.
   */
  readonly representations?: ArtifactRepresentations | null;
}

/** The artifact moved on before the write landed; nothing was persisted. */
export interface ArtifactPatchStoreConflict {
  /** Revision the artifact carries instead of `previous.revision`. */
  readonly conflictingRevision: string;
}

/**
 * The host refused the write before writing anything; nothing was persisted.
 *
 * This is the return shape for a refusal the host makes before any effect — a
 * write validator that inspects the payload and touches nothing. A refusal
 * that surfaces after side-effecting steps ran (a later lifecycle hook
 * rejecting after earlier hooks acted) must stay a throw, because "resend the
 * corrected patch" is only safe when the whole store attempt left no trace.
 * One message plus optional per-path issues, no error taxonomy: the caller's
 * next step is the same for every side-effect-free refusal.
 */
export interface ArtifactPatchStoreRejection {
  readonly rejection: {
    /** Why the host refused the write. */
    readonly message: string;
    /** Per-path rejections, when the refusal names locations in `data`. */
    readonly issues?: readonly ArtifactPatchIssue[];
  };
}

/** The persisted revision, the conflict that stopped it, or the host's refusal. */
export type ArtifactPatchStoreResult = ArtifactRevision | ArtifactPatchStoreConflict | ArtifactPatchStoreRejection;

/**
 * Recognize a store outcome that refused to overwrite a concurrent revision.
 * @param result - Outcome reported by the host.
 * @returns Whether the write was refused rather than performed.
 */
function isStoreConflict(result: ArtifactPatchStoreResult): result is ArtifactPatchStoreConflict {
  return 'conflictingRevision' in result;
}

/**
 * Recognize a store outcome that refused the write before writing anything.
 * @param result - Outcome reported by the host.
 * @returns Whether the host refused deterministically rather than persisting.
 */
function isStoreRejection(result: ArtifactPatchStoreResult): result is ArtifactPatchStoreRejection {
  return 'rejection' in result;
}

/**
 * Report the host's deterministic refusal as a structured rejection.
 *
 * The host refused before writing anything, so unlike a thrown failure the
 * outcome is known: the base revision still stands and the caller corrects the
 * input instead of re-reading.
 * @param refused - The host's refusal.
 * @returns The rejection to report.
 */
function storeRejection(refused: ArtifactPatchStoreRejection): ArtifactPatchError {
  // The response contract is strict and requires non-empty issue fields, and
  // the tool registry does not re-validate successful output, so host-provided
  // issues are normalized here — the same boundary check `checkStoredRevision`
  // applies to the host's revision. An invalid entry is dropped rather than
  // failing the rejection: the refusal stays actionable through its message.
  const issues = (refused.rejection.issues ?? [])
    .map((issue) => ArtifactPatchIssueSchema.safeParse(issue))
    .flatMap((parsed) => (parsed.success ? [parsed.data] : []));
  // Same boundary rule for the message: a blank one would manufacture a
  // schema-valid error that names nothing, so it is replaced with a fallback
  // that tells the caller the host itself is what needs the report.
  const reason = refused.rejection.message.trim();
  return {
    code: 'STORE_REJECTED',
    message:
      reason === '' ? 'The host refused the write without naming a reason.' : `The host refused the write: ${reason}`,
    ...(issues.length === 0 ? {} : { issues }),
    repair:
      'Nothing was persisted. Correct what the rejection names and resend the patch against the same baseRevision.',
  };
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
   * before the failure surfaced. A refusal the host makes before any effect —
   * its own write validator inspecting the payload — is returned as
   * `ArtifactPatchStoreRejection` instead of thrown, so the caller learns that
   * nothing was persisted and what to correct. Return it only when the whole
   * store attempt is known to be side-effect-free: a rejection that follows
   * side-effecting steps (a later lifecycle hook refusing after earlier hooks
   * acted) must stay a throw. `ArtifactPatchStoreConflict` remains the refusal
   * for a concurrent revision; both returned refusals promise nothing was
   * persisted.
   *
   * The new revision is stored at `request.schemaVersion`, which is the version
   * the payload was validated against. It equals `previous.schemaVersion`
   * unless the request migrated the artifact.
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
 * re-read, which the concurrent revision may have written for a reason. A
 * request that names `representations` is never rebasable either: the hints
 * were authored against the base the caller read, and resending them would
 * overwrite whatever hints the concurrent revision wrote. Nor is a request
 * that names a target `schemaVersion`, even one equal to the base's: the
 * concurrent revision may itself have migrated the artifact, and resending the
 * version chosen against the old base would validate and store the result
 * under a version the artifact has already left.
 * @param input - The rejected patch request.
 * @returns Whether every instruction still means the same thing on a newer revision.
 */
function isRebasable(input: ArtifactPatchRequest): boolean {
  if (input.representations !== undefined || input.schemaVersion !== undefined) return false;
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
      : `Re-read the artifact at revision '${currentRevision}' and rewrite the patch: only an append at a fixed path survives a concurrent write, with no position and no filter. Replacing, removing, addressing an entry by position, appending through a $[filter] placeholder, replacing or clearing representations, and naming a target schemaVersion all depend on the payload you read, which the concurrent revision may have changed.`,
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
 * Compile the checker for the registration the patched result is held to.
 * @param registration - Registration whose data schema is compiled.
 * @returns The checker, or the rejection when the declared schema does not compile.
 */
function compileChecker(registration: ArtifactKindRegistration): ArtifactDataChecker | ArtifactPatchError {
  try {
    return compileArtifactDataChecker(registration);
  } catch (error) {
    return {
      code: 'HOST_FAILED',
      message: `Artifact kind '${registration.kind}' could not compile its data schema: ${failureMessage(error)}`,
      repair: 'Correct the registered data schema before patching artifacts of this kind.',
    };
  }
}

/**
 * Resolve the registration the patched result must satisfy.
 *
 * The target is the request's `schemaVersion` when it names one, else the
 * stored revision's. A revision left at an older version by a kind bump has
 * no registration at its own version any more; naming the newer version is
 * how a caller migrates it, and the whole patched result — declared paths and
 * schema alike — is then held to that registration.
 * @param registrations - Effective registrations reported by the host.
 * @param artifact - Revision the patch applies to.
 * @param target - Schema version the patched result is validated against.
 * @returns The matching registration, or the rejection explaining its absence.
 */
function resolveRegistration(
  registrations: readonly ArtifactKindRegistration[],
  artifact: ArtifactRevision,
  target: number,
): ArtifactKindRegistration | ArtifactPatchError {
  const candidates = registrations.filter((candidate) => candidate.kind === artifact.kind);
  if (candidates.length === 0) {
    return {
      code: 'KIND_NOT_REGISTERED',
      message: `Artifact kind '${artifact.kind}' is not registered.`,
      repair: 'Register the kind, or address an artifact of a registered kind.',
    };
  }
  const registration = candidates.find((candidate) => candidate.schemaVersion === target);
  if (!registration) {
    const registered = [...new Set(candidates.map((candidate) => candidate.schemaVersion))].sort((a, b) => a - b);
    const versions = registered.join(', ');
    const origin =
      target === artifact.schemaVersion
        ? `Revision '${artifact.revision}' uses schema version ${target}`
        : `The request targets schema version ${target} for revision '${artifact.revision}' (schema version ${artifact.schemaVersion})`;
    // Only a newer registration is a target the caller can reach: a migration
    // never moves an artifact back, so an older registered version is named
    // as registered but not recommended.
    const reachable = registered.filter((version) => version > artifact.schemaVersion).join(', ');
    return {
      code: 'SCHEMA_VERSION_MISMATCH',
      message: `${origin}, for which '${artifact.kind}' has no registration; registered: ${versions}.`,
      repair:
        reachable === ''
          ? `Register '${artifact.kind}' at schema version ${target}${target > artifact.schemaVersion ? '' : ' or newer'}; no registered version is newer than the revision's.`
          : `Set schemaVersion to one of ${reachable} and add the instructions that make the payload fit that version, or register '${artifact.kind}' at schema version ${target}.`,
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
  const registration = resolveTargetRegistration(input, artifact, registrations);
  if ('code' in registration) return failed(registration);
  const migrating = registration.schemaVersion !== artifact.schemaVersion;
  const checker = compileChecker(registration);
  if (typeof checker !== 'function') return failed(checker);

  // A migration may `$unset` a property the target no longer declares; nothing
  // else about the removal is policed here. Whether the completed payload is
  // acceptable is the target schema's decision alone, made by the validation
  // below, and an explicit `$unset` is the caller's decision: the package
  // carries no migration logic, so it does not judge which properties the
  // target "really" refuses through patterns, open containers or composition
  // branches.
  const applied = applyArtifactPatch(artifact.data, input.patch, registration.dataSchema, {
    allowUndeclaredRemovals: migrating,
  });
  if (!applied.ok) return failed(applied.error);

  const check = checker(applied.application.data);
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

  // The patch checks `data` and the title, nothing beside them. Evidence is
  // carried over unchanged and a patch cannot add any, so a target
  // registration with a higher `evidenceRequirements.minItems` is a case the
  // host's lifecycle writer rejects at store time, as it does for every other
  // revision-level rule; the patch does not duplicate that writer's checks,
  // and a dry run promises no more than the data-level checks it ran.
  const operations = [...applied.application.operations];
  const migration = migrating ? { migration: { from: artifact.schemaVersion, to: registration.schemaVersion } } : {};
  if (input.dryRun === true) return { ok: true, base, dryRun: true, operations, ...migration };

  let stored: ArtifactPatchStoreResult;
  try {
    stored = await host.store(
      {
        previous: artifact,
        data: applied.application.data,
        schemaVersion: registration.schemaVersion,
        ...(input.statusPath === undefined ? {} : { statusPath: input.statusPath }),
        ...(input.representations === undefined ? {} : { representations: input.representations }),
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
  if (isStoreRejection(stored)) return failed(storeRejection(stored));
  const mislabelled = checkStoredRevision(stored, base, registration.schemaVersion);
  if (mislabelled) return failed(mislabelled);
  return {
    ok: true,
    base,
    dryRun: false,
    artifact: artifactRef(stored.kind, stored.id, stored.revision),
    operations,
    ...migration,
  };
}

/**
 * Pick the registration the patched payload is held to, and refuse a request
 * that would produce a revision identical to its base.
 *
 * The target is the requested `schemaVersion` or, absent that, the base
 * revision's own. A patch without instructions is only meaningful as a
 * migration: at the base's own version it changes nothing.
 * @param input - The patch request.
 * @param artifact - Revision the patch was written against.
 * @param registrations - Registrations the host reports for the kind.
 * @returns The target registration, or the rejection to report.
 */
function resolveTargetRegistration(
  input: ArtifactPatchRequest,
  artifact: ArtifactRevision,
  registrations: readonly ArtifactKindRegistration[],
): ArtifactKindRegistration | ArtifactPatchError {
  if (input.schemaVersion !== undefined && input.schemaVersion < artifact.schemaVersion) {
    // Several generations may be registered at once. A migration only moves
    // forward: storing the revision under an older generation would let a
    // caller regress the artifact's history and drop what newer schemas added.
    return {
      code: 'SCHEMA_VERSION_MISMATCH',
      message: `The request targets schema version ${input.schemaVersion}, older than revision '${artifact.revision}' (schema version ${artifact.schemaVersion}); a migration never moves an artifact back.`,
      repair: `Omit schemaVersion to patch at version ${artifact.schemaVersion}, or name a newer registered version to migrate the artifact forward.`,
    };
  }
  const registration = resolveRegistration(registrations, artifact, input.schemaVersion ?? artifact.schemaVersion);
  if ('code' in registration) return registration;
  if (registration.schemaVersion === artifact.schemaVersion && artifactPatchInstructions(input.patch).length === 0) {
    return {
      code: 'NO_CHANGE',
      message: `The patch carries no instruction and targets schema version ${registration.schemaVersion}, which revision '${artifact.revision}' already has.`,
      repair: 'Add at least one instruction, or name a different schemaVersion to migrate the artifact.',
    };
  }
  return registration;
}

/**
 * Check that the host persisted a new revision of the patched artifact at the
 * schema version the payload was validated against.
 *
 * A host that stored the payload under another version has labelled the
 * revision wrongly, and a migration that silently kept the old label is not a
 * migration.
 * @param stored - Revision the host reported as persisted.
 * @param base - Revision the patch was applied to.
 * @param schemaVersion - Version the patched payload was validated against.
 * @returns The rejection to report, or undefined when the stored revision is sound.
 */
function checkStoredRevision(
  stored: ArtifactRevision,
  base: ArtifactRef,
  schemaVersion: number,
): ArtifactPatchError | undefined {
  if (stored.kind !== base.kind || stored.id !== base.id || stored.revision === base.revision) {
    return {
      code: 'HOST_FAILED',
      message: 'The store returned an artifact that is not a new revision of the patched one.',
      repair: 'Re-read the artifact before patching it again; the write outcome is unclear.',
    };
  }
  if (stored.schemaVersion !== schemaVersion) {
    return {
      code: 'HOST_FAILED',
      message: `The store persisted revision '${stored.revision}' at schema version ${stored.schemaVersion} instead of ${schemaVersion}.`,
      repair:
        'Re-read the artifact; the host did not store the revision at the schema version the patch was validated against.',
    };
  }
  return undefined;
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
