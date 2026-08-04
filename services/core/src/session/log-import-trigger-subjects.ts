/**
 * Local mirror of the log-import bus subjects observed-session ingestion calls.
 *
 * The log-import service package depends on this package, so importing its
 * subject definitions here would create a package cycle. Bus subjects are
 * matched by fully-qualified name and payloads are validated against the
 * schemas registered by the owning service at boot — these mirrored
 * definitions are type carriers for the fields the ingestion path reads and
 * writes, not a second source of truth. Canonical schemas live with the
 * log-import service, whose conformance test pins this mirror against them.
 * @packageDocumentation
 */

import { createBusNamespace } from '@makaio/core';
import { z } from 'zod';
import { TurnIngestionMarkerSchema } from '@makaio/contracts';

/**
 * The three log-import subjects observed-session ingestion triggers.
 *
 * Exported for tests that stub the log-import seam and for the owning
 * service's conformance pin; not part of the public session API surface.
 * @internal
 */
export const LogImportTriggerSubjects = createBusNamespace('log-import', {
  /** Mirror of `log-import.listImporters` (adapterName/clientId subset). */
  listImporters: {
    request: z.object({}),
    response: z.object({
      /** Registered importers; only the correlation fields are typed here. */
      importers: z.array(
        z.object({
          /** Importer adapter name — the `source` identity used by imports. */
          adapterName: z.string(),
          /** Client application id whose hooks observe this importer's sessions. */
          clientId: z.string().optional(),
        }),
      ),
    }),
  },
  /** Mirror of `log-import.importFile` (path-addressable import trigger). */
  importFile: {
    request: z.object({
      /** Absolute path to the transcript file on disk. */
      filePath: z.string(),
      /** Registered importer adapter name. */
      adapterName: z.string(),
      /** Marker stamped on emitted `session.turn.*` events. */
      ingestionMarker: TurnIngestionMarkerSchema.optional(),
    }),
    response: z.discriminatedUnion('status', [
      z.object({
        /** File was imported and persisted. */
        status: z.literal('imported'),
        /** Makaio session ID that was populated. */
        sessionId: z.string(),
        /** Number of messages persisted. */
        messageCount: z.number(),
        /** Number of turns persisted. */
        turnCount: z.number(),
      }),
      z.object({
        /** Request was gracefully skipped. */
        status: z.literal('skipped'),
        /** Machine-readable skip reason. */
        reason: z.enum(['no-importer', 'file-missing']),
      }),
    ]),
  },
  /** Mirror of `log-import.importSession` (discovery-stub-based trigger). */
  importSession: {
    request: z.object({
      /** External session ID provided by the adapter. */
      adapterSessionId: z.string(),
      /** Registered importer adapter name. */
      adapterName: z.string(),
      /** Marker stamped on emitted `session.turn.*` events. */
      ingestionMarker: TurnIngestionMarkerSchema.optional(),
    }),
    response: z.object({
      /** Makaio session ID that was populated. */
      sessionId: z.string(),
      /** Number of messages imported into the session. */
      messageCount: z.number(),
    }),
  },
}).subjects;
