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
import { ClientRuntimeObserveSchema, ClientRuntimeStartedSchema } from './runtime-observation.js';
import {
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
} satisfies SchemaRecord;
