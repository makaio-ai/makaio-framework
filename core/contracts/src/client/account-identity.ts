/**
 * Account and identity schemas for the client domain.
 *
 * Covers identifiers, usage windows, scan targets, usage snapshots,
 * session locators, identity observations, and the account-observe /
 * usage-ingest request–response pairs.
 * @packageDocumentation
 */

import { z } from 'zod';
import { JsonObjectSchema } from '../shared/index.js';
import { EpochMillisecondsSchema, NonEmptyStringSchema } from './primitives.js';
import { VersionRangeSchema } from '../version/index.js';

/**
 * Strength classification for a client account identifier.
 */
export const ClientIdentifierStrengthSchema = z.enum(['strong', 'alias']);

export type ClientIdentifierStrength = z.infer<typeof ClientIdentifierStrengthSchema>;

/**
 * A canonical or derived identifier for a client account.
 */
export const ClientAccountIdentifierSchema = z.object({
  scheme: NonEmptyStringSchema,
  value: NonEmptyStringSchema,
  strength: ClientIdentifierStrengthSchema,
});

export type ClientAccountIdentifier = z.infer<typeof ClientAccountIdentifierSchema>;

/**
 * A normalized usage window for a client account.
 */
export const ClientUsageWindowSchema = z.object({
  key: NonEmptyStringSchema,
  label: z.string(),
  usedPercentage: z.number().finite().min(0).max(100),
  resetsAt: EpochMillisecondsSchema.optional(),
});

export type ClientUsageWindow = z.infer<typeof ClientUsageWindowSchema>;

/**
 * The usage windows container shared by snapshot and ingest schemas.
 */
export const ClientUsageWindowsSchema = z.object({
  windows: z.array(ClientUsageWindowSchema),
});

export type ClientUsageWindows = z.infer<typeof ClientUsageWindowsSchema>;

/**
 * Open metadata map shared by client account and usage contracts.
 */
export const ClientMetadataSchema = z.record(z.string(), z.unknown()).optional();

/**
 * A detected client binary scan result.
 */
export const ClientScanResultSchema = z.object({
  clientId: NonEmptyStringSchema,
  found: z.boolean(),
  version: z.string().optional(),
  warningMessage: z.string().optional(),
});

export type ClientScanResult = z.infer<typeof ClientScanResultSchema>;

/**
 * Explicit CLI scan target supplied by callers that already resolved clients.
 *
 * `binaryName` is the resolved executable name for PATH lookup — kept as a
 * flat field because this is a resolved scan parameter, not a definition
 * shape. `supportedVersions` is the semver range used to validate the
 * detected binary version.
 */
export const ClientScanTargetSchema = z.object({
  clientId: NonEmptyStringSchema,
  binaryName: NonEmptyStringSchema,
  supportedVersions: VersionRangeSchema.optional(),
});

export type ClientScanTarget = z.infer<typeof ClientScanTargetSchema>;

/**
 * Canonical usage snapshot emitted after stitching identity and usage.
 */
export const ClientUsageSnapshotSchema = z.object({
  clientAccountId: NonEmptyStringSchema,
  clientId: NonEmptyStringSchema,
  observedAt: EpochMillisecondsSchema,
  source: NonEmptyStringSchema,
  displayLabel: z.string().optional(),
  usage: ClientUsageWindowsSchema,
  metadata: ClientMetadataSchema,
});

export type ClientUsageSnapshot = z.infer<typeof ClientUsageSnapshotSchema>;

/**
 * Session locator used to correlate an observation to a session.
 */
export const ClientSessionLocatorSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('session'),
    sessionId: NonEmptyStringSchema,
  }),
  z.object({
    kind: z.literal('adapter-session'),
    adapterSessionId: NonEmptyStringSchema,
  }),
  z.object({
    kind: z.literal('both'),
    sessionId: NonEmptyStringSchema,
    adapterSessionId: NonEmptyStringSchema,
  }),
]);

export type ClientSessionLocator = z.infer<typeof ClientSessionLocatorSchema>;

/**
 * Raw client identity observation captured from a client runtime.
 *
 * These top-level fields stay syntactically permissive because adapters capture
 * raw client evidence before canonical account-linking normalizes it. The
 * persisted payload shape is still constrained to JSON so storage/event seams
 * can safely serialize and snapshot observations.
 */
export const ClientIdentityObservationSchema = z.object({
  clientId: z.string(),
  source: z.string(),
  kind: z.string(),
  observedAt: EpochMillisecondsSchema,
  payload: JsonObjectSchema,
});

export type ClientIdentityObservation = z.infer<typeof ClientIdentityObservationSchema>;

/**
 * Request and response schemas for client.account.observe.
 */
export const ClientAccountObserveSchema = {
  request: z.object({
    clientId: NonEmptyStringSchema,
    observedAt: EpochMillisecondsSchema.optional(),
    displayLabel: z.string().optional(),
    identifiers: z.array(ClientAccountIdentifierSchema).min(1),
    metadata: ClientMetadataSchema,
  }),
  response: z.object({
    clientAccountId: NonEmptyStringSchema,
    displayLabel: z.string().optional(),
  }),
};

export type ClientAccountObserveRequest = z.infer<typeof ClientAccountObserveSchema.request>;
export type ClientAccountObserveResponse = z.infer<typeof ClientAccountObserveSchema.response>;

/**
 * Request and response schemas for client.session.account.observe.
 */
export const ClientSessionAccountObserveSchema = {
  request: ClientIdentityObservationSchema.extend({
    locator: ClientSessionLocatorSchema,
  }),
  response: z.object({
    handled: z.boolean(),
    sessionId: NonEmptyStringSchema.nullable(),
    clientAccountId: NonEmptyStringSchema.nullable(),
    changed: z.boolean(),
  }),
};

export type ClientSessionAccountObserveRequest = z.infer<typeof ClientSessionAccountObserveSchema.request>;
export type ClientSessionAccountObserveResponse = z.infer<typeof ClientSessionAccountObserveSchema.response>;

/**
 * Request and response schemas for client.usage.ingest.
 */
export const ClientUsageIngestSchema = {
  request: z.object({
    clientId: NonEmptyStringSchema,
    observedAt: EpochMillisecondsSchema,
    source: NonEmptyStringSchema,
    account: z.object({
      displayLabel: z.string().optional(),
      identifiers: z.array(ClientAccountIdentifierSchema).min(1),
    }),
    usage: ClientUsageWindowsSchema,
    metadata: ClientMetadataSchema,
  }),
  response: z.object({
    clientAccountId: NonEmptyStringSchema,
    snapshot: ClientUsageSnapshotSchema,
  }),
};

export type ClientUsageIngestRequest = z.infer<typeof ClientUsageIngestSchema.request>;
export type ClientUsageIngestResponse = z.infer<typeof ClientUsageIngestSchema.response>;
