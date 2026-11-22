/**
 * Routing metadata extraction and collision detection for namespace registration.
 *
 * These helpers determine transport routing behavior (local-only, collector-only,
 * host-local-request, channel) from schema wrapper layers. The metadata must be
 * identical across duplicate namespace registrations — a mismatch means the same
 * subject name carries different security/routing semantics depending on
 * registration order.
 * @packageDocumentation
 */

import type { JournalOptions, SubjectMarks, SubjectSchemaInspection } from '@makaio/core';

/**
 * Routing metadata flags extracted from a subject schema's wrapper layer.
 *
 * These flags determine transport routing behavior (local-only, collector-only,
 * host-local-request, channel) and must be identical across duplicate namespace
 * registrations. A mismatch means the same subject name is registered with
 * different security/routing semantics, which silently breaks invariants.
 */
export interface SubjectRoutingMetadata {
  /** Whether the subject was wrapped with `localSubject()`. */
  local: boolean;
  /** Whether the subject was wrapped with `collectorOnlySubject()`. */
  collectorOnly: boolean;
  /** Whether the subject was wrapped with `channelSubject()`. */
  channel: boolean;
  /** Whether the subject was wrapped with `hostLocalRequest()`. */
  hostLocalRequest: boolean;
  /** Subject-level default transport policy, if any. */
  defaultTransports: 'all' | 'local-only' | undefined;
  /** Journal declaration from a `journalSubject()` wrapper, if any. */
  journal?: JournalOptions;
}

/**
 * Project a schema inspection's marks to the routing metadata shape.
 *
 * Reused by namespace registration from the inspections `buildNamespaceInspections`
 * already built, so routing metadata is never derived by a second traversal of
 * the same schema.
 * @param marks - Marks collected by a single schema inspection traversal
 * @returns Routing metadata flags for the inspected schema
 */
export function routingMetadataFromMarks(marks: SubjectMarks): SubjectRoutingMetadata {
  return {
    local: marks.local,
    collectorOnly: marks.collectorOnly,
    channel: marks.channel,
    hostLocalRequest: marks.hostLocalRequest,
    defaultTransports: marks.defaultTransports,
    journal: marks.journal,
  };
}

/**
 * Compare two payload retention settings: both absent, both `'keep'`, or the
 * same `maxAgeMs`.
 * @param existing - Retention of the already-registered subject, if any
 * @param incoming - Retention of the new registration, if any
 * @returns True when both settings are equal
 */
function retainPayloadEqual(
  existing: JournalOptions['retainPayload'],
  incoming: JournalOptions['retainPayload'],
): boolean {
  if (typeof existing === 'object' && typeof incoming === 'object') return existing.maxAgeMs === incoming.maxAgeMs;
  return existing === incoming;
}

/**
 * Compare two party-kind lists by content and order; both absent counts as equal.
 * @param existing - List of the already-registered subject, if any
 * @param incoming - List of the new registration, if any
 * @returns True when both lists are equal
 */
function partyKindsEqual(existing: readonly string[] | undefined, incoming: readonly string[] | undefined): boolean {
  if (existing === undefined || incoming === undefined) return existing === incoming;
  return existing.length === incoming.length && existing.every((kind, index) => kind === incoming[index]);
}

/**
 * Compare two subjects' journal declarations for a duplicate registration.
 *
 * Equal when both are absent, or when `schemaVersion`, `retention`,
 * `retainPayload` and `suggestedFor` (per direction, order significant) are
 * equal and `readOlder` has the same `kind`. `retention` defaults to
 * `'volatile'` (the documented default of `JournalOptions.retention`), so an absent
 * `retention` on one side compares equal to an explicit `'volatile'` on the
 * other.
 *
 * `readOlder` is compared by `kind` rather than function identity: the same
 * contract declared independently (for example by two bundles that each
 * carry it) has equivalent upgrade functions with different identities, so
 * comparing by identity would reject such a legitimate duplicate
 * registration.
 * @param existing - Journal declaration of the already-registered subject, if any
 * @param incoming - Journal declaration of the new registration, if any
 * @returns True when the two declarations are equal
 */
export function journalDeclarationsEqual(
  existing: JournalOptions | undefined,
  incoming: JournalOptions | undefined,
): boolean {
  if (existing === undefined || incoming === undefined) return existing === incoming;

  return (
    existing.schemaVersion === incoming.schemaVersion &&
    (existing.retention ?? 'volatile') === (incoming.retention ?? 'volatile') &&
    retainPayloadEqual(existing.retainPayload, incoming.retainPayload) &&
    partyKindsEqual(existing.suggestedFor?.send, incoming.suggestedFor?.send) &&
    partyKindsEqual(existing.suggestedFor?.subscribe, incoming.suggestedFor?.subscribe) &&
    existing.readOlder?.kind === incoming.readOlder?.kind
  );
}

/**
 * Build the routing metadata map for one namespace registration from its
 * schema inspections.
 *
 * Takes the schema inspections a namespace registration already built with one
 * {@link inspectSubjectSchema} traversal per subject, instead of re-traversing
 * the raw schemas, so each subject is inspected exactly once per registration.
 * @param inspections - Schema inspections keyed by canonical subject key.
 * @returns Routing metadata keyed by subject key.
 */
export function buildNamespaceRoutingMetadataFromInspections(
  inspections: ReadonlyMap<string, SubjectSchemaInspection<unknown>>,
): ReadonlyMap<string, SubjectRoutingMetadata> {
  const metadataMap = new Map<string, SubjectRoutingMetadata>();
  for (const [subject, inspection] of inspections) {
    metadataMap.set(subject, routingMetadataFromMarks(inspection.marks));
  }
  return metadataMap;
}

/**
 * Format routing metadata for human-readable error messages.
 * @param metadata - Routing metadata to format
 * @returns Comma-separated list of active routing flags
 */
export function formatRoutingMetadata(metadata: SubjectRoutingMetadata): string {
  const flags: string[] = [];
  if (metadata.local) flags.push('local');
  if (metadata.collectorOnly) flags.push('collectorOnly');
  if (metadata.channel) flags.push('channel');
  if (metadata.hostLocalRequest) flags.push('hostLocalRequest');
  if (metadata.defaultTransports) flags.push(`defaultTransports=${metadata.defaultTransports}`);
  if (metadata.journal) flags.push(`journal=${JSON.stringify(metadata.journal)}`);
  return flags.length > 0 ? flags.join(', ') : '(none)';
}

/**
 * Fail registration when duplicate namespace registrations disagree on routing metadata.
 *
 * Routing metadata (local, collectorOnly, channel, hostLocalRequest, defaultTransports,
 * journal) determines security-critical transport behavior and recorded-event
 * semantics. A mismatch means the same subject name carries different routing or
 * journal semantics depending on registration order, which silently defeats security
 * boundaries like the no-relay guarantee of hostLocalRequest.
 * @param domain - Namespace domain name
 * @param existingMetadata - Routing metadata from the already-registered namespace
 * @param incomingMetadata - Routing metadata from the new registration attempt
 * @throws Error when any subject has different routing metadata across registrations
 */
export function failOnRoutingMetadataCollision(
  domain: string,
  existingMetadata: ReadonlyMap<string, SubjectRoutingMetadata>,
  incomingMetadata: ReadonlyMap<string, SubjectRoutingMetadata>,
): void {
  const conflicts: string[] = [];
  for (const [subject, incoming] of incomingMetadata) {
    const existing = existingMetadata.get(subject);
    if (!existing) continue;
    if (
      existing.local !== incoming.local ||
      existing.collectorOnly !== incoming.collectorOnly ||
      existing.channel !== incoming.channel ||
      existing.hostLocalRequest !== incoming.hostLocalRequest ||
      existing.defaultTransports !== incoming.defaultTransports ||
      !journalDeclarationsEqual(existing.journal, incoming.journal)
    ) {
      conflicts.push(
        `${subject}: existing=[${formatRoutingMetadata(existing)}], incoming=[${formatRoutingMetadata(incoming)}]`,
      );
    }
  }
  if (conflicts.length === 0) return;

  throw new Error(
    `[MakaioBus] Namespace '${domain}' already registered with different routing metadata. ` +
      `Routing metadata must be identical across registrations because it determines ` +
      `security-critical transport behavior. Conflicts: ${conflicts.join('; ')}`,
  );
}
