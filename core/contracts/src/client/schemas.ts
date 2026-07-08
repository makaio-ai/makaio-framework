/**
 * Client namespace schema aggregator.
 *
 * Assembles the complete `ClientSchemas` record from the domain-focused
 * sub-modules and satisfies the `SchemaRecord` contract required by
 * `MakaioBus.registerNamespace`. This file is intentionally thin — it owns
 * no schema definitions; those live in their respective domain files.
 * @packageDocumentation
 */

import type { SchemaRecord } from '@makaio/core';
import { z } from 'zod';
import { ClientResolveBinarySchema } from './binary-resolution.js';
import {
  ClientInstallCompletedSchema,
  ClientInstallProgressSchema,
  ClientInstallSchema,
  ClientListSchema,
  ClientSetActiveSchema,
  ClientUninstallSchema,
  ClientUpdateSchema,
  ClientVersionChangedSchema,
} from './binary-management.js';
import { AbsolutePathSchema, NonEmptyStringSchema } from './primitives.js';
import {
  ClientRuntimeObserveSchema,
  ClientRuntimeStartedSchema,
  ClientRuntimeIsAdapterManagedSchema,
} from './runtime-observation.js';
import {
  ClientAccountIdentifierSchema,
  ClientAccountObserveSchema,
  ClientScanResultSchema,
  ClientScanTargetSchema,
  ClientSessionAccountObserveSchema,
  ClientUsageIngestSchema,
  ClientUsageSnapshotSchema,
} from './account-identity.js';
import {
  ClientSessionStartedSchema,
  ClientSessionTurnCompletedSchema,
  ClientSessionTurnStartedSchema,
  ClientSessionToolPostSchema,
  ClientSessionToolPreSchema,
  ClientSessionUserPromptSubmittedSchema,
  ClientWiringEntrySchema,
} from './session-observed.js';
import { ClientConfigPrimeSchema, ClientProfileSchemas, ClientSessionConfigSchemas } from './profile.js';

export { ClientExecutionContextSchema, ClientResolveBinarySchema } from './binary-resolution.js';
export type {
  ClientExecutionContext,
  ClientResolveBinaryRequest,
  ClientResolveBinaryResponse,
} from './binary-resolution.js';

/**
 * Client namespace schemas.
 */
export const ClientSchemas = {
  'runtime.observe': ClientRuntimeObserveSchema,
  'runtime.started': ClientRuntimeStartedSchema,
  'runtime.isAdapterManaged': ClientRuntimeIsAdapterManagedSchema,
  scan: {
    request: z.object({
      targets: z.array(ClientScanTargetSchema).optional(),
    }),
    response: z.object({
      results: z.array(ClientScanResultSchema),
    }),
  },
  'session.account.observe': ClientSessionAccountObserveSchema,
  'account.observe': ClientAccountObserveSchema,
  /**
   * Signal which account is currently active for a client.
   *
   * Called by the account-manager after successfully linking an account
   * via `client.account.observe`. `ClientRuntimeService` persists the
   * supplied identity in memory so that other services (e.g. the Claude
   * Code client service) can query it without a session lookup.
   */
  'account.activate': {
    request: z.object({
      /** Stable client identifier (e.g. `'claude-code'`, `'codex'`). */
      clientId: NonEmptyStringSchema,
      /** Canonical client account ID assigned by clients-core. */
      clientAccountId: NonEmptyStringSchema,
      /** At least one identifier that characterises this account. */
      identifiers: z.array(ClientAccountIdentifierSchema).min(1),
      /** Optional human-readable label for this account. */
      displayLabel: z.string().optional(),
    }),
    response: z.object({ accepted: z.boolean() }),
  },
  /**
   * Retrieve the currently active account identity for a client.
   *
   * Returns the identity most recently signalled via `account.activate`,
   * or `null` when no activation has been recorded for the given client.
   * Used as a fallback by the Claude Code client service when a statusline
   * payload cannot be correlated to a persisted session.
   */
  'account.getActive': {
    request: z.object({
      /** Stable client identifier to query. */
      clientId: NonEmptyStringSchema,
    }),
    response: z.object({
      /** Most recently activated identity, or `null` when none exists. */
      identity: z
        .object({
          clientAccountId: NonEmptyStringSchema,
          identifiers: z.array(ClientAccountIdentifierSchema).min(1),
          displayLabel: z.string().optional(),
        })
        .nullable(),
    }),
  },
  'usage.ingest': ClientUsageIngestSchema,
  'usage.snapshot': ClientUsageSnapshotSchema,
  // Observed session semantics — normalized lifecycle signals from adapters
  'session.started': ClientSessionStartedSchema,
  'session.userPrompt.submitted': ClientSessionUserPromptSubmittedSchema,
  'session.turn.started': ClientSessionTurnStartedSchema,
  'session.turn.completed': ClientSessionTurnCompletedSchema,
  'session.tool.pre': ClientSessionToolPreSchema,
  'session.tool.post': ClientSessionToolPostSchema,
  'wiring.list': {
    request: z.object({
      /**
       * When provided, only this client's wiring entries are returned.
       * Omit to aggregate all enabled clients.
       */
      clientId: NonEmptyStringSchema.optional(),
      /** Project directory used to scope wiring entry inspection. */
      projectDir: AbsolutePathSchema.optional(),
      /** Makaio CLI command used to build expected wiring command strings. */
      makaioCommand: NonEmptyStringSchema,
    }),
    response: z.object({
      /** Aggregated wiring results, one entry per responding client. */
      results: z.array(
        z.object({
          /** Stable client identifier (e.g. 'claude-code', 'codex'). */
          clientId: NonEmptyStringSchema,
          /** All wiring entries reported by this client. */
          entries: z.array(ClientWiringEntrySchema),
        }),
      ),
    }),
  },
  // Binary management — command/response subjects
  list: ClientListSchema,
  install: ClientInstallSchema,
  uninstall: ClientUninstallSchema,
  update: ClientUpdateSchema,
  setActive: ClientSetActiveSchema,
  // Binary management — event subjects (fire-and-forget)
  'installJob.progress': ClientInstallProgressSchema,
  'installJob.completed': ClientInstallCompletedSchema,
  'version.changed': ClientVersionChangedSchema,
  // Binary resolution
  resolveBinary: ClientResolveBinarySchema,
  // Profile management
  ...ClientProfileSchemas,
  // Session config isolation
  ...ClientSessionConfigSchemas,
  // Generic blocking config-prime lifecycle hook
  'config.prime': ClientConfigPrimeSchema,
} satisfies SchemaRecord;
