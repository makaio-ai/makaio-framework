/**
 * Published-contract export tripwire for the session-ingestion surface.
 *
 * Every symbol the ingestion contract promises to downstream consumers is
 * imported here via its package specifier (never via relative paths), exactly
 * as an external consumer would import it. If a barrel re-export is dropped or
 * renamed, this suite fails at compile time (type-only symbols) or at runtime
 * (values), long before a downstream package notices.
 *
 * Covered surface:
 * - `@makaio/contracts` (root and the `./session` subpath share one barrel):
 *   ingestion marker, session-level turn events, import-upsert registration.
 * - `@makaio/contracts/client`: observed-session hook event contracts.
 * - `@makaio/services-core/session`: turn ingestion seam + lifecycle event
 *   persistence helpers (and the absence of the retired `SessionLogger`).
 * - `@makaio/services-log-import`: file-addressable import trigger.
 * - `@makaio/hooks`: PostTurn backfill filter option.
 * - `@makaio/ai-adapters-core`: importer registration and segment-tree types.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';

import { MakaioSessionSchema, SessionRecordMetadataSchema, TurnIngestionMarkerSchema } from '@makaio/contracts';
import type { ImportUpsertRequest, TurnCompleted, TurnIngestionMarker, TurnStarted } from '@makaio/contracts';
import { ClientSessionStartedSchema, ClientSessionTurnCompletedSchema } from '@makaio/contracts/client';
import type { ClientSessionStarted, ClientSessionTurnCompleted } from '@makaio/contracts/client';
import type {
  DiscoveryMetadata,
  ImportSegment,
  ImportSegmentTurn,
  LogImportRegistration,
  ProcessLogFileResult,
} from '@makaio/ai-adapters-core';
import type { PostTurnHookOptions } from '@makaio/hooks';
import * as sessionCore from '@makaio/services-core/session';
import { LogImportSubjects, registerImportFileHandler } from '@makaio/services-log-import';

describe('published contract exports (session ingestion surface)', () => {
  describe('@makaio/contracts', () => {
    it('exports the turn ingestion marker schema', () => {
      expect(TurnIngestionMarkerSchema.parse('live')).toBe('live');
      expect(TurnIngestionMarkerSchema.parse('backfill')).toBe('backfill');
      expect(TurnIngestionMarkerSchema.safeParse('bogus').success).toBe(false);
    });

    it('carries the ingestion marker on session-level turn event types', () => {
      expectTypeOf<TurnStarted['ingestionMarker']>().toEqualTypeOf<TurnIngestionMarker | undefined>();
      expectTypeOf<TurnCompleted['ingestionMarker']>().toEqualTypeOf<TurnIngestionMarker | undefined>();
    });

    it('exports the opaque session record metadata schema', () => {
      const sample = { origin: 'hook-registration', correlationId: 'abc' };
      expect(SessionRecordMetadataSchema.parse(sample)).toEqual(sample);
    });

    it('exposes isSidechain on the session schema', () => {
      expect(MakaioSessionSchema.shape.isSidechain).toBeDefined();
      expect(MakaioSessionSchema.shape.isSidechain.safeParse(true).success).toBe(true);
    });

    it('exposes the unified registration fields on ImportUpsertRequest', () => {
      expectTypeOf<ImportUpsertRequest['importStatus']>().toEqualTypeOf<'discovered' | 'tracking' | undefined>();
      expectTypeOf<ImportUpsertRequest['isSidechain']>().toEqualTypeOf<boolean | undefined>();
      expectTypeOf<ImportUpsertRequest['metadata']>().not.toBeNever();
      expectTypeOf<ImportUpsertRequest['lastClientIdentityObservation']>().not.toBeNever();
    });
  });

  describe('@makaio/contracts/client', () => {
    it('carries transcriptPath and cwd on observed-session event contracts', () => {
      expectTypeOf<ClientSessionStarted['transcriptPath']>().toEqualTypeOf<string | undefined>();
      expectTypeOf<ClientSessionStarted['cwd']>().toEqualTypeOf<string | undefined>();
      expectTypeOf<ClientSessionTurnCompleted['transcriptPath']>().toEqualTypeOf<string | undefined>();
      expect(ClientSessionStartedSchema.shape.transcriptPath).toBeDefined();
      expect(ClientSessionStartedSchema.shape.cwd).toBeDefined();
      expect(ClientSessionTurnCompletedSchema.shape.transcriptPath).toBeDefined();
    });
  });

  describe('@makaio/services-core/session', () => {
    it('exports the turn ingestion seam', () => {
      expect(typeof sessionCore.ingestCompletedTurn).toBe('function');
      expectTypeOf<sessionCore.IngestCompletedTurnParams['turnAnchorId']>().toEqualTypeOf<string>();
      expectTypeOf<sessionCore.IngestTurnMessage['adapterMessageId']>().toEqualTypeOf<string>();
      expectTypeOf<sessionCore.IngestCompletedTurnResult['created']>().toEqualTypeOf<boolean>();
    });

    it('exports the session lifecycle event helpers', () => {
      expect(typeof sessionCore.appendSessionLifecycleEvent).toBe('function');
      expect(typeof sessionCore.registerSessionLifecycleEventWriters).toBe('function');
      expect(typeof sessionCore.emitSessionTurnStarted).toBe('function');
      expectTypeOf<sessionCore.EventTransform>().not.toBeNever();
    });

    it('no longer exposes the retired SessionLogger', () => {
      expect('SessionLogger' in sessionCore).toBe(false);
    });
  });

  describe('@makaio/services-log-import', () => {
    it('exposes the file-addressable import trigger', () => {
      expect(typeof LogImportSubjects.importFile.subject).toBe('string');
      expect(typeof registerImportFileHandler).toBe('function');
    });
  });

  describe('@makaio/hooks', () => {
    it('exposes the PostTurn backfill filter option', () => {
      expectTypeOf<PostTurnHookOptions['includeBackfill']>().toEqualTypeOf<boolean | undefined>();
    });
  });

  describe('@makaio/ai-adapters-core', () => {
    it('exposes segment-tree turn types and importer clientId', () => {
      expectTypeOf<LogImportRegistration['clientId']>().toEqualTypeOf<string | undefined>();
      expectTypeOf<ImportSegment['turns']>().toEqualTypeOf<ImportSegmentTurn[] | undefined>();
      expectTypeOf<ProcessLogFileResult['turns']>().toEqualTypeOf<ImportSegmentTurn[] | undefined>();
      expectTypeOf<DiscoveryMetadata>().not.toBeNever();
    });
  });
});
