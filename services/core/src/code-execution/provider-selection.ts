import {
  CODE_EXECUTION_IDENTIFIER_MAX_LENGTH,
  CODE_EXECUTION_TRUST_LEVELS,
  type CodeExecutionRequirements,
  type CodeExecutionTrustLevel,
  type ICapabilityProvider,
  type ICodeExecutionProvider,
} from '@makaio/contracts';

/**
 * Failure codes the selector can produce when no provider is admitted.
 *
 * Both are `failed`-outcome codes, so the router can hand a rejection
 * straight to its failure normalization without re-mapping.
 */
export type CodeExecutionSelectionFailureCode = 'provider_unavailable' | 'invalid_provider';

/** Selection result admitting exactly one provider for the invocation. */
export interface CodeExecutionProviderSelected {
  /** Discriminant: a provider was admitted. */
  readonly admitted: true;
  /**
   * The admitted provider's identifier, as read during selection.
   *
   * Carried out of the selector rather than re-read from `provider` at the
   * point of use. Selection reads every field exactly once under containment,
   * but a registration whose `id` accessor throws — or answers something else —
   * on a *later* read would otherwise turn a diagnostic or a failure summary
   * into a rejected bus handler. The identifier a caller reports is therefore
   * the identifier selection actually admitted.
   */
  readonly id: string;
  /**
   * The entry point selection validated, carried out of the selector.
   *
   * Read once during selection and never read off `provider` again, for the
   * same reason {@link id} is not: a registration is free to answer a *different*
   * function on a later read — or to throw — and the callable that runs must be
   * the callable admission checked. It is invoked with `provider` as its `this`,
   * so a class-based registration keeps its own binding.
   */
  readonly execute: ICodeExecutionProvider['execute'];
  /** The single provider admitted for this invocation, used as the `this` binding. */
  readonly provider: ICodeExecutionProvider;
}

/** Selection result admitting no provider, carrying the failure classification. */
export interface CodeExecutionProviderRejected {
  /** Discriminant: no provider was admitted. */
  readonly admitted: false;
  /** Failure classification for the normalized outcome. */
  readonly code: CodeExecutionSelectionFailureCode;
}

/** Discriminated result of one selection pass over the live provider bucket. */
export type CodeExecutionProviderSelection = CodeExecutionProviderSelected | CodeExecutionProviderRejected;

/**
 * Plain, immutable copy of the fields selection decides on.
 *
 * Holds no reference to the live registration beyond `provider`, which is
 * carried through untouched so the admitted provider is invoked with its own
 * `this` binding. Everything selection *reads* comes from the snapshot,
 * including the entry point it will be invoked through.
 */
interface CodeExecutionProviderCandidate {
  /** Provider identifier, copied once under containment. */
  readonly id: string;
  /** Selection priority, copied once under containment. */
  readonly priority: number;
  /** Runtime tag, copied once under containment. */
  readonly runtime: string;
  /** Language tag, copied once under containment. */
  readonly language: string;
  /** Module format, copied once under containment. */
  readonly moduleFormat: string;
  /** Trust level, copied once under containment. */
  readonly trust: CodeExecutionTrustLevel;
  /** Entry point, copied once under containment and validated as callable. */
  readonly execute: ICodeExecutionProvider['execute'];
  /** The live registration itself, returned as the `this` binding for invocation. */
  readonly provider: ICodeExecutionProvider;
}

/**
 * Narrow an unknown property to a non-empty string.
 * @param value - Property value read off a live registration.
 * @returns `true` when the value is a usable non-empty string tag.
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Narrow an unknown property to a request-addressable selection identifier.
 * @param value - Property value read off a live registration.
 * @returns `true` when the value is non-empty and within the public request limit.
 */
function isSelectionIdentifier(value: unknown): value is string {
  return isNonEmptyString(value) && value.length <= CODE_EXECUTION_IDENTIFIER_MAX_LENGTH;
}

/**
 * Read every field selection depends on, once, and validate the values read.
 *
 * Registrations reach the capability registry as live objects that no schema
 * ever validated — the registry deliberately stores references rather than
 * payloads. Selection therefore refuses to hand a request to an object whose
 * declared selection fields or `execute` entry point are missing or of the
 * wrong type, instead of discovering that inside the invocation.
 *
 * `displayName` is validated here even though nothing in this module decides
 * anything on it, and that is the point: it is required by `ICapabilityProvider`
 * and it is what `CapabilitySubjects.list` answers with, so a registration
 * missing it satisfies no schema anywhere — it merely fails somewhere else, when
 * a UI lists the bucket and the response no longer matches its own contract.
 * A registration this module admits must be one the registry can describe, so
 * the same contained read that decides admission decides that too. It is read
 * and discarded rather than carried: routing never displays a provider, and
 * carrying a field no caller uses would only invite a later reader to trust a
 * copy that is a selection-time snapshot of something a UI should read live.
 *
 * Every property access on such an object is itself untrusted work: an accessor
 * or a proxy trap may throw, or may answer once and throw on the next read. So
 * each field is read exactly once, here, inside the containment — validation,
 * requirement filtering, and the priority comparator all run on these copies.
 * Two consequences follow, and both are the point:
 *
 * - A read that throws is answered `undefined` rather than propagated. Were the
 *   field read again later, the throw would land in filtering or ordering, which
 *   run outside any containment, and surface at the bus handler as a rejected
 *   subject instead of as `invalid_provider`.
 * - The values that are validated are exactly the values that are used. A
 *   second read could answer something the validation never saw, which would put
 *   an unchecked value into a snapshot field the type claims is checked.
 *
 * A registration that answers a *different but valid* value than it would have
 * on some other read is simply selected on the values it gave, which is no
 * different from one that changed between two separate selections — a live
 * registry offers no stronger promise.
 *
 * The live object is carried through as `provider` as well, because it is the
 * `this` binding the admitted `execute` is called with — a class-based
 * registration relies on it. What the snapshot does *not* do is leave `execute`
 * behind to be re-read at the point of use: the callable validated here is the
 * callable invoked, so a stateful getter cannot answer a plain object during
 * validation and a different function — or a throw — at invocation time.
 * @param candidate - Live registration read from the capability bucket.
 * @returns The snapshot, or `undefined` when the registration is malformed.
 */
function snapshotCodeExecutionProvider(candidate: ICapabilityProvider): CodeExecutionProviderCandidate | undefined {
  try {
    const {
      id,
      displayName,
      priority,
      runtime,
      language,
      moduleFormat,
      trust,
      execute,
    }: Partial<ICodeExecutionProvider> = candidate;
    if (
      !isSelectionIdentifier(id) ||
      !isNonEmptyString(displayName) ||
      typeof priority !== 'number' ||
      !Number.isFinite(priority) ||
      !isSelectionIdentifier(runtime) ||
      !isSelectionIdentifier(language) ||
      !isSelectionIdentifier(moduleFormat) ||
      !isTrustLevel(trust) ||
      typeof execute !== 'function'
    ) {
      return undefined;
    }
    // `candidate` is the object those values were just read from, so it is the
    // provider they describe. Narrowing it any other way would mean reading it
    // a second time, which is exactly what this function exists to avoid.
    const provider = candidate as ICodeExecutionProvider;
    return { id, priority, runtime, language, moduleFormat, trust, execute, provider };
  } catch {
    return undefined;
  }
}

/**
 * Narrow an unknown property to a declared trust level.
 * @param value - Property value read off a live registration.
 * @returns `true` when the value names a known trust level.
 */
function isTrustLevel(value: unknown): value is CodeExecutionTrustLevel {
  return typeof value === 'string' && (CODE_EXECUTION_TRUST_LEVELS as readonly string[]).includes(value);
}

/**
 * Test one candidate snapshot against every declared requirement.
 *
 * Every requirement field is an exact-match constraint and omitted fields
 * impose none, so a request without requirements matches every provider.
 * @param candidate - Snapshot of a well-formed provider's selection metadata.
 * @param requirements - Constraints declared by the request, when any.
 * @returns `true` when the provider satisfies every declared constraint.
 */
function satisfies(
  candidate: CodeExecutionProviderCandidate,
  requirements: CodeExecutionRequirements | undefined,
): boolean {
  if (requirements === undefined) return true;
  return (
    (requirements.providerId === undefined || requirements.providerId === candidate.id) &&
    (requirements.runtime === undefined || requirements.runtime === candidate.runtime) &&
    (requirements.language === undefined || requirements.language === candidate.language) &&
    (requirements.moduleFormat === undefined || requirements.moduleFormat === candidate.moduleFormat) &&
    (requirements.trust === undefined || requirements.trust === candidate.trust)
  );
}

/**
 * Order two eligible candidate snapshots by descending priority, then ascending id.
 *
 * The id tie-break is what makes selection reproducible: registration order
 * in the capability bucket depends on host composition and extension boot
 * order, so it must not decide which provider runs a request.
 * @param left - First candidate of the comparison.
 * @param right - Second candidate of the comparison.
 * @returns Negative when `left` sorts first, positive when `right` does, `0` when equal.
 */
function byPriorityThenId(left: CodeExecutionProviderCandidate, right: CodeExecutionProviderCandidate): number {
  if (left.priority !== right.priority) return right.priority - left.priority;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

/**
 * Determine whether a live bucket contains two valid snapshots with the same ID.
 *
 * Provider IDs are the bucket's stable routing identities. Continuing with a
 * duplicate would make the stable sort fall back to registration order when
 * priorities tie, so selection must reject the composition error before
 * requirement filtering can hide either duplicate.
 * @param candidates - Well-formed provider snapshots from one live bucket.
 * @returns `true` when at least two snapshots declare the same provider ID.
 */
function hasDuplicateProviderIds(candidates: readonly CodeExecutionProviderCandidate[]): boolean {
  const ids = new Set<string>();
  for (const candidate of candidates) {
    if (ids.has(candidate.id)) return true;
    ids.add(candidate.id);
  }
  return false;
}

/**
 * Select the single provider that will execute one invocation.
 *
 * Pure over the live bucket: the input array is never reordered or mutated,
 * because it is the capability registry's own storage. Malformed
 * registrations — including ones whose property accessors throw — are
 * excluded from selection rather than invoked, so this function is total: it
 * returns a classification for every bucket instead of throwing at its caller.
 *
 * Every field of every registration is read exactly once, into snapshots;
 * validation, requirement filtering, and ordering then all run on those plain
 * values. The admitted provider's live object leaves this function so it is
 * invoked with its own `this` binding — accompanied by its snapshotted `id` and
 * `execute`, so no caller has to read a field off that live object again, either
 * to describe it or to invoke it.
 *
 * Duplicate snapshot IDs are always `invalid_provider`, before requirement
 * filtering can hide the ambiguity. When no provider is otherwise admitted,
 * `invalid_provider` takes precedence over `provider_unavailable` whenever the
 * bucket held at least one malformed registration. Both are actionable local
 * composition faults, and reporting "no provider available" for either would
 * hide the only signal that something was registered wrongly.
 * @param candidates - Live `code-execution` bucket from the capability registry.
 * @param requirements - Exact-match constraints declared by the request, when any.
 * @returns The admitted provider, or the failure code to normalize.
 */
export function selectCodeExecutionProvider(
  candidates: readonly ICapabilityProvider[],
  requirements: CodeExecutionRequirements | undefined,
): CodeExecutionProviderSelection {
  const wellFormed = candidates
    .map(snapshotCodeExecutionProvider)
    .filter((candidate): candidate is CodeExecutionProviderCandidate => candidate !== undefined);
  const hadMalformed = wellFormed.length !== candidates.length;
  if (hasDuplicateProviderIds(wellFormed)) {
    return { admitted: false, code: 'invalid_provider' };
  }
  const eligible = wellFormed.filter((candidate) => satisfies(candidate, requirements));

  // `eligible` is already a fresh array produced by `filter`, so sorting it in
  // place cannot reorder the registry's own storage.
  const [admitted] = eligible.sort(byPriorityThenId);
  if (admitted !== undefined) {
    return { admitted: true, id: admitted.id, execute: admitted.execute, provider: admitted.provider };
  }

  return { admitted: false, code: hadMalformed ? 'invalid_provider' : 'provider_unavailable' };
}
