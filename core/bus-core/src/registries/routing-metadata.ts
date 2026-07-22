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

import type { SubjectSchema } from '@makaio/core';
import { isCollectorOnlySchema, isHostLocalRequestSchema, isDefaultTransportsSchema } from '@makaio/core';
import { isChannelSchema } from '../utils/channel-schema.js';
import { isLocalSchema } from '../utils/local-schema.js';

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
}

/**
 * Extract routing metadata from a raw (possibly wrapped) subject schema.
 * @param schema - Raw subject schema, possibly wrapped with localSubject, hostLocalRequest, etc.
 * @returns Routing metadata flags for the schema
 */
export function extractRoutingMetadata(schema: SubjectSchema): SubjectRoutingMetadata {
  return {
    local: isLocalSchema(schema),
    collectorOnly: isCollectorOnlySchema(schema),
    channel: isChannelSchema(schema),
    hostLocalRequest: isHostLocalRequestSchema(schema),
    defaultTransports: isDefaultTransportsSchema(schema)
      ? (schema.__defaultTransports as 'all' | 'local-only')
      : undefined,
  };
}

/**
 * Build the routing metadata map for one namespace registration.
 * @param schemas - Raw subject schemas from a namespace definition.
 * @returns Routing metadata keyed by subject key.
 */
export function buildNamespaceRoutingMetadata(
  schemas: Record<string, SubjectSchema>,
): ReadonlyMap<string, SubjectRoutingMetadata> {
  const metadataMap = new Map<string, SubjectRoutingMetadata>();
  for (const [subject, schema] of Object.entries(schemas)) {
    metadataMap.set(subject, extractRoutingMetadata(schema));
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
  return flags.length > 0 ? flags.join(', ') : '(none)';
}

/**
 * Fail registration when duplicate namespace registrations disagree on routing metadata.
 *
 * Routing metadata (local, collectorOnly, channel, hostLocalRequest, defaultTransports)
 * determines security-critical transport behavior. A mismatch means the same subject
 * name carries different routing semantics depending on registration order, which
 * silently defeats security boundaries like the no-relay guarantee of hostLocalRequest.
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
      existing.defaultTransports !== incoming.defaultTransports
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
