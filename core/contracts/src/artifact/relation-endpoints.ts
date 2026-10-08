import type { RelationEndpoint, RelationTargetRefClass, RelationTypeRegistration } from './schemas.js';

/** The source kind, target reference class and optional target kind of one concrete relation. */
export interface RelationEndpointCandidate {
  /** Kind of the source artifact. */
  readonly sourceKind: string;
  /** Reference class of the relation target. */
  readonly targetRefClass: RelationTargetRefClass;
  /** Kind of the target, when the target carries one. */
  readonly targetKind?: string;
}

/** Per-type properties on which two registrations of the same relation type can conflict. */
export type RelationTypeConflictField = 'symmetry' | 'implication' | 'description';

/** Thrown when two registrations of the same relation type disagree on a per-type property. */
export class RelationTypeConflictError extends Error {
  /** The relation type the conflict concerns. */
  public readonly type: string;
  /** The per-type property the registrations disagree on. */
  public readonly field: RelationTypeConflictField;

  /**
   * @param type - Relation type of the existing registration.
   * @param field - Property the registrations disagree on.
   * @param existing - Value on the existing registration.
   * @param next - Conflicting value on the further registration.
   */
  public constructor(type: string, field: RelationTypeConflictField, existing: string, next: string) {
    super(
      `Relation type '${type}' is already registered with different ${field} (existing: '${existing}', new: '${next}')`,
    );
    this.name = 'RelationTypeConflictError';
    this.type = type;
    this.field = field;
  }
}

/**
 * Normal form of a registration: shorthand folded into `endpoints`; an open
 * type carries no endpoints.
 */
export type NormalizedRelationTypeRegistration = Omit<
  RelationTypeRegistration,
  'sourceKinds' | 'targetKinds' | 'targetRefClasses'
>;

/**
 * Builds an endpoint from optional lists, omitting absent lists. The description is
 * not read here: a registration's own `description` describes the verb, not a pair.
 * @param lists - The three optional endpoint lists.
 * @returns An endpoint carrying only the present lists.
 */
function buildEndpoint(lists: Omit<RelationEndpoint, 'description'>): RelationEndpoint {
  return {
    ...(lists.sourceKinds === undefined ? {} : { sourceKinds: lists.sourceKinds }),
    ...(lists.targetKinds === undefined ? {} : { targetKinds: lists.targetKinds }),
    ...(lists.targetRefClasses === undefined ? {} : { targetRefClasses: lists.targetRefClasses }),
  };
}

/**
 * Endpoints of a registration: `endpoints` when present, else one entry built
 * from the shorthand fields. A registration without any constraint yields a
 * single open entry `{}`. An explicit empty `endpoints` list yields no entry
 * and therefore permits nothing.
 * @param registration - The registration to read.
 * @returns The endpoint entries; empty only for an explicit empty `endpoints` list.
 */
export function relationTypeEndpoints(registration: RelationTypeRegistration): readonly RelationEndpoint[] {
  return registration.endpoints ?? [buildEndpoint(registration)];
}

/**
 * Checks one allowlist against a value; an omitted list is open.
 * @param list - Optional allowlist.
 * @param value - Candidate value, possibly undefined.
 * @returns True when the list is omitted or contains the value.
 */
function listPermits<T extends string>(list: readonly T[] | undefined, value: T | undefined): boolean {
  if (list === undefined) {
    return true;
  }
  return value !== undefined && list.includes(value);
}

/**
 * Whether the endpoint permits the candidate. Each present list is an
 * allowlist; a present `targetKinds` with an undefined `candidate.targetKind`
 * is a miss.
 * @param endpoint - The endpoint entry to test.
 * @param candidate - The concrete relation to test.
 * @returns True when all present lists permit the candidate.
 */
export function relationEndpointPermits(endpoint: RelationEndpoint, candidate: RelationEndpointCandidate): boolean {
  return (
    listPermits(endpoint.sourceKinds, candidate.sourceKind) &&
    listPermits(endpoint.targetKinds, candidate.targetKind) &&
    listPermits(endpoint.targetRefClasses, candidate.targetRefClass)
  );
}

/**
 * The candidate seen from the other end of a symmetric relation. Under a
 * symmetric type `A to B` is the same relation as `B to A`. Only an artifact can
 * be a source, so the reversal needs an artifact target that carries a kind.
 * A registration whose `implication` names a different type has a distinct
 * inverse, which that type's own registration governs; it is not reversed here.
 * @param registration - The registration the candidate is tested against.
 * @param candidate - The concrete relation as given.
 * @returns The reversed candidate, or undefined when the registration or candidate admits no reversal.
 */
function reversedCandidate(
  registration: RelationTypeRegistration,
  candidate: RelationEndpointCandidate,
): RelationEndpointCandidate | undefined {
  const selfInverse = registration.implication === undefined || registration.implication === registration.type;
  if (
    registration.symmetry !== 'symmetric' ||
    !selfInverse ||
    candidate.targetRefClass !== 'artifact' ||
    candidate.targetKind === undefined
  ) {
    return undefined;
  }
  return { sourceKind: candidate.targetKind, targetRefClass: 'artifact', targetKind: candidate.sourceKind };
}

/**
 * Whether at least one endpoint of the registration permits the candidate.
 * A self-inverse symmetric registration also permits the reversed candidate
 * (see {@link reversedCandidate}). Each entry is checked whole, forward or
 * reversed, so kinds from different entries never mix.
 * @param registration - The registration to test.
 * @param candidate - The concrete relation to test.
 * @returns True when any endpoint entry permits the candidate, or its reversal where one applies.
 */
export function relationTypePermits(
  registration: RelationTypeRegistration,
  candidate: RelationEndpointCandidate,
): boolean {
  const reversed = reversedCandidate(registration, candidate);
  return relationTypeEndpoints(registration).some(
    (endpoint) =>
      relationEndpointPermits(endpoint, candidate) ||
      (reversed !== undefined && relationEndpointPermits(endpoint, reversed)),
  );
}

/**
 * Sorts and deduplicates a list; an omitted list stays omitted.
 * @param list - Optional list.
 * @returns A new sorted, deduplicated list, or undefined.
 */
function normalizeList<T extends string>(list: readonly T[] | undefined): T[] | undefined {
  return list === undefined ? undefined : [...new Set(list)].sort();
}

/**
 * Normalises one endpoint entry: sorted, deduplicated lists; the description is kept.
 * @param endpoint - The entry to normalise.
 * @returns A new normalised entry.
 */
function normalizeEndpoint(endpoint: RelationEndpoint): RelationEndpoint {
  const lists = buildEndpoint({
    sourceKinds: normalizeList(endpoint.sourceKinds),
    targetKinds: normalizeList(endpoint.targetKinds),
    targetRefClasses: normalizeList(endpoint.targetRefClasses),
  });
  return endpoint.description === undefined ? lists : { ...lists, description: endpoint.description };
}

/**
 * Structural key of a normalised entry; an omitted list differs from a present one.
 * @param endpoint - A normalised entry.
 * @returns A string equal for structurally equal entries.
 */
function endpointKey(endpoint: RelationEndpoint): string {
  return JSON.stringify([
    endpoint.sourceKinds ?? null,
    endpoint.targetKinds ?? null,
    endpoint.targetRefClasses ?? null,
    endpoint.description ?? null,
  ]);
}

/**
 * Whether an entry carries no constraint at all. A description is no constraint.
 * @param endpoint - A normalised entry.
 * @returns True when the entry has no lists.
 */
function isOpenEndpoint(endpoint: RelationEndpoint): boolean {
  // Normalised entries come from `buildEndpoint` and never carry undefined keys.
  return (
    endpoint.sourceKinds === undefined && endpoint.targetKinds === undefined && endpoint.targetRefClasses === undefined
  );
}

/**
 * Normalises entries: sorted lists, structurally equal entries deduplicated.
 * @param entries - Endpoint entries.
 * @returns Entries sorted by structural key (so merge order does not matter), or undefined when any entry is open.
 */
function normalizeEndpoints(entries: readonly RelationEndpoint[]): RelationEndpoint[] | undefined {
  const byKey = new Map<string, RelationEndpoint>();
  for (const entry of entries) {
    const normalized = normalizeEndpoint(entry);
    if (isOpenEndpoint(normalized)) {
      return undefined;
    }
    byKey.set(endpointKey(normalized), normalized);
  }
  return [...byKey.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, entry]) => entry);
}

/**
 * Builds a registration from its per-type properties and normalised entries.
 * An empty entry list stays an empty `endpoints` list, so the registration stays fail-closed.
 * @param verb - Registration providing `type`, `symmetry`, `implication` and `description`.
 * @param entries - Endpoint entries to normalise.
 * @returns A new registration without shorthand fields.
 */
function assembleRegistration(
  verb: Pick<RelationTypeRegistration, 'type' | 'symmetry' | 'implication' | 'description'>,
  entries: readonly RelationEndpoint[],
): NormalizedRelationTypeRegistration {
  const endpoints = normalizeEndpoints(entries);
  return {
    type: verb.type,
    symmetry: verb.symmetry,
    ...(verb.implication === undefined ? {} : { implication: verb.implication }),
    ...(verb.description === undefined ? {} : { description: verb.description }),
    ...(endpoints === undefined ? {} : { endpoints }),
  };
}

/**
 * Normal form of a registration: shorthand folded into `endpoints`; lists
 * sorted and deduplicated; structurally equal entries deduplicated. An entry
 * without any constraint makes the type open, in which case `endpoints` is
 * omitted. The result never carries the shorthand fields.
 * @param registration - The registration to normalise.
 * @returns A new normalised registration.
 */
export function normalizeRelationTypeRegistration(
  registration: RelationTypeRegistration,
): NormalizedRelationTypeRegistration {
  return assembleRegistration(registration, relationTypeEndpoints(registration));
}

/**
 * Resolves the implication of two registrations of the same type.
 * @param existing - Existing registration.
 * @param next - Further registration.
 * @returns The implication present on either side.
 * @throws RelationTypeConflictError when both carry differing implications.
 */
function mergeImplication(existing: RelationTypeRegistration, next: RelationTypeRegistration): string | undefined {
  if (
    existing.implication !== undefined &&
    next.implication !== undefined &&
    existing.implication !== next.implication
  ) {
    throw new RelationTypeConflictError(existing.type, 'implication', existing.implication, next.implication);
  }
  return existing.implication ?? next.implication;
}

/**
 * Resolves the description of two registrations of the same type.
 * @param existing - Existing registration.
 * @param next - Further registration.
 * @returns The description present on either side.
 * @throws RelationTypeConflictError when both carry differing descriptions.
 */
function mergeDescription(existing: RelationTypeRegistration, next: RelationTypeRegistration): string | undefined {
  if (
    existing.description !== undefined &&
    next.description !== undefined &&
    existing.description !== next.description
  ) {
    throw new RelationTypeConflictError(existing.type, 'description', existing.description, next.description);
  }
  return existing.description ?? next.description;
}

/**
 * Merges a further contribution into an existing registration of the same type.
 * `implication` and `description` are taken from whichever side has them. Endpoints are the
 * normalised union of both entry lists. An unconstrained side makes the merged
 * type open (its `endpoints` are omitted), because an open entry permits every
 * pair. Mutates neither input.
 * @param existing - The existing registration.
 * @param next - The further contribution.
 * @returns A new normalised registration.
 * @throws Error when `type` differs.
 * @throws RelationTypeConflictError when `symmetry` differs, or when both carry a differing `implication` or `description`.
 */
export function mergeRelationTypeRegistrations(
  existing: RelationTypeRegistration,
  next: RelationTypeRegistration,
): NormalizedRelationTypeRegistration {
  if (existing.type !== next.type) {
    throw new Error(`Cannot merge relation type '${next.type}' into relation type '${existing.type}'`);
  }
  if (existing.symmetry !== next.symmetry) {
    throw new RelationTypeConflictError(existing.type, 'symmetry', existing.symmetry, next.symmetry);
  }
  const implication = mergeImplication(existing, next);
  const description = mergeDescription(existing, next);
  return assembleRegistration({ type: existing.type, symmetry: existing.symmetry, implication, description }, [
    ...relationTypeEndpoints(existing),
    ...relationTypeEndpoints(next),
  ]);
}
