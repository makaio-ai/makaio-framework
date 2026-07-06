/**
 * End-to-end integration test of the observed-session ingestion chain
 * (AC1, AC6, AC8, AC11).
 *
 * Everything this package owns runs REAL: the ObservedSessionIngestionService,
 * the turn ingestion seam (`ingestCompletedTurn`), the in-memory storage
 * handlers (session, turn, message, session-event), and the lifecycle-event
 * writers baked into the seam. The only substituted boundary is the
 * log-import service — a downstream dependent contributed by another package —
 * whose stub faithfully mirrors the real importer: it resolves the session via
 * `storage:session.importUpsert` and feeds every reconstructed transcript turn
 * through the REAL ingest seam with the marker from the request.
 *
 * Chain under test:
 * `client.session.started` → session registration (unified seam) →
 * `client.session.turn.completed` → `log-import.importFile` (stub) →
 * `ingestCompletedTurn` → `session.turn.started` / `session.turn.completed`
 * with the four-point consumer contract already satisfied at emission time.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects, ClientSubjects, SessionSubjects } from '@makaio/contracts';
import type { IMakaioSession, SessionMessage, Turn, TurnIngestionMarker } from '@makaio/contracts';
import { SessionStorageSubjects } from '../storage/namespace.js';
import { TurnStorageSubjects } from '../turns/index.js';
import { MessageStorageSubjects } from '../messages/namespace.js';
import { registerMemorySessionStorage } from '../storage/memory-handler.js';
import { registerMemoryTurnStorage } from '../turns/memory-handler.js';
import { registerMemoryMessageStorage } from '../messages/memory-handler.js';
import { registerMemorySessionEventStorage } from '../session-events/memory-handler.js';
import { LogImportTriggerSubjects, ObservedSessionIngestionService } from '../observed-session-ingestion.js';
import { ingestCompletedTurn, type IngestTurnMessage } from '../turn-ingest.js';
import { SessionTurnManager } from '../session-turn-manager.js';
import { SessionBridge } from '../session-bridge.js';
import {
  collectTurnStartedEvents,
  collectTurnCompletedEvents,
  type UnsubscribeFunction,
} from '../testing/orchestrator-event-collectors.js';
import { getStoredEvents, resetBusHandlers, waitForAsync } from './shared.js';

/** Client id reported by the observed hook events. */
const CLIENT_ID = 'obs-client';
/** Importer adapter name — the `source` identity of the import path. */
const ADAPTER_NAME = 'obs-cli';
/** External session id shared by hooks and transcript. */
const ADAPTER_SESSION_ID = 'ext-1';
/** Transcript path carried in the hook payloads. */
const TRANSCRIPT_PATH = '/tmp/x.jsonl';

/** A reconstructed turn of the prepared in-test transcript. */
interface TranscriptTurn {
  /** Anchor id — the adapterMessageId of the turn-start user message. */
  anchorId: string;
  /** Turn start timestamp (Unix ms). */
  startedAt: number;
  /** Turn completion timestamp (Unix ms). */
  completedAt: number;
  /** Messages of the turn in transcript order. */
  messages: IngestTurnMessage[];
}

/**
 * Build the prepared transcript: two completed turns of one user + one
 * assistant message each, anchored on the user message's record uuid.
 * @returns Transcript turns in file order
 */
function buildTranscript(): TranscriptTurn[] {
  const buildTurn = (anchorId: string, baseTs: number, text: string): TranscriptTurn => ({
    anchorId,
    startedAt: baseTs,
    completedAt: baseTs + 2_000,
    messages: [
      {
        adapterMessageId: anchorId,
        role: 'user',
        contentText: `ask ${text}`,
        blocks: [{ type: 'text', content: `ask ${text}` }],
        adapterSessionId: ADAPTER_SESSION_ID,
        timestamp: baseTs,
      },
      {
        adapterMessageId: `${anchorId}-reply`,
        role: 'assistant',
        contentText: `answer ${text}`,
        blocks: [{ type: 'text', content: `answer ${text}` }],
        agentId: 'obs-agent',
        adapterSessionId: ADAPTER_SESSION_ID,
        timestamp: baseTs + 1_000,
      },
    ],
  });
  return [buildTurn('rec-1', 10_000, 'one'), buildTurn('rec-2', 20_000, 'two')];
}

/** Captured `log-import.importFile` request payloads. */
interface ImportFileRequest {
  filePath: string;
  adapterName: string;
  ingestionMarker?: TurnIngestionMarker;
}

/**
 * Stub the log-import service boundary (the one substituted seam).
 *
 * `importFile` mirrors the real importer's behavior: it upserts the session
 * identity through the unified registration seam (enrichment path — the
 * hook-first registration already created the row), then drives every
 * transcript turn through the REAL `ingestCompletedTurn` with the marker
 * from the request, and finally reports `imported`.
 * @param unsubs - Array to push subscription cleanups into
 * @param transcript - Prepared transcript the stub "parses"
 * @returns Captured importFile request payloads
 */
function stubLogImportService(unsubs: UnsubscribeFunction[], transcript: TranscriptTurn[]): ImportFileRequest[] {
  const importFileRequests: ImportFileRequest[] = [];

  unsubs.push(
    MakaioBus.on(LogImportTriggerSubjects.listImporters, (ctx) => {
      ctx.setResult({ importers: [{ adapterName: ADAPTER_NAME, clientId: CLIENT_ID }] });
    }),
    MakaioBus.on(LogImportTriggerSubjects.importFile, async (ctx) => {
      importFileRequests.push(ctx.payload);
      const { sessionId } = await MakaioBus.request(SessionStorageSubjects.importUpsert, {
        kind: 'root',
        parentAdapterSessionId: null,
        forkPointMessageId: null,
        externalSessionId: ADAPTER_SESSION_ID,
        source: ctx.payload.adapterName,
        cwd: null,
        logFilePath: ctx.payload.filePath,
      });
      for (const turn of transcript) {
        await ingestCompletedTurn(MakaioBus, {
          sessionId,
          turnAnchorId: turn.anchorId,
          startedAt: turn.startedAt,
          completedAt: turn.completedAt,
          status: 'completed',
          ingestionMarker: ctx.payload.ingestionMarker ?? 'backfill',
          messages: turn.messages,
        });
      }
      ctx.setResult({
        status: 'imported',
        sessionId,
        messageCount: transcript.reduce((sum, turn) => sum + turn.messages.length, 0),
        turnCount: transcript.length,
      });
    }),
  );

  return importFileRequests;
}

/**
 * Storage state captured INSIDE the `session.turn.completed` subscriber —
 * i.e. exactly what a consumer observes at emission time, before the emit
 * resolves. This is the four-point consumer contract probe.
 */
interface ContractSnapshot {
  /** Contract point 4: the event payload fields. */
  payload: {
    sessionId: string;
    turnId: string;
    turnNumber: number;
    success: boolean;
    ingestionMarker?: TurnIngestionMarker;
  };
  /** Contract point 1: session row loaded at event time. */
  session: IMakaioSession | null;
  /** Contract point 2: the turn row (from getBySession) at event time. */
  turn: Turn | undefined;
  /** Contract point 3: messages via getByTurn at event time. */
  messages: SessionMessage[];
}

/**
 * Subscribe to `session.turn.completed` and snapshot storage state at event
 * time. Because the bus awaits event handlers, all storage reads here happen
 * strictly before the emitting flow continues.
 * @param unsubs - Array to push the subscription cleanup into
 * @returns Snapshots in emission order
 */
function collectContractSnapshots(unsubs: UnsubscribeFunction[]): ContractSnapshot[] {
  const snapshots: ContractSnapshot[] = [];
  unsubs.push(
    MakaioBus.on(SessionSubjects.turn.completed, async (ctx) => {
      const { sessionId, turnId, turnNumber, success, ingestionMarker } = ctx.payload;
      const [{ session }, { turns }, { messages }] = await Promise.all([
        MakaioBus.request(SessionStorageSubjects.get, { sessionId }),
        MakaioBus.request(TurnStorageSubjects.getBySession, { sessionId }),
        MakaioBus.request(MessageStorageSubjects.getByTurn, { turnId }),
      ]);
      snapshots.push({
        payload: { sessionId, turnId, turnNumber, success, ingestionMarker },
        session,
        turn: turns.find((turn: Turn) => turn.turnId === turnId),
        messages,
      });
    }),
  );
  return snapshots;
}

/**
 * Count `session.created` emissions.
 * @param unsubs - Array to push the subscription cleanup into
 * @returns Mutable counter object
 */
function countSessionCreated(unsubs: UnsubscribeFunction[]): { count: number } {
  const counter = { count: 0 };
  unsubs.push(
    MakaioBus.on(SessionSubjects.created, () => {
      counter.count += 1;
    }),
  );
  return counter;
}

/**
 * Emit the two hook observations of a live observed turn: session start
 * (identity) followed by turn completion (cadence / import trigger).
 * @param adapterSessionId - External session id of the observed session
 */
async function emitObservedTurnFlow(adapterSessionId = ADAPTER_SESSION_ID): Promise<void> {
  await MakaioBus.emit(ClientSubjects.session.started, {
    clientId: CLIENT_ID,
    source: 'native-hook',
    observedAt: 1_000,
    adapterSessionId,
    transcriptPath: TRANSCRIPT_PATH,
    metadata: { consumer: 'v' },
  });
  await MakaioBus.emit(ClientSubjects.session.turn.completed, {
    clientId: CLIENT_ID,
    source: 'native-hook',
    observedAt: 2_000,
    adapterSessionId,
    transcriptPath: TRANSCRIPT_PATH,
  });
}

describe('observed-session ingestion end-to-end (integration)', () => {
  let service: ObservedSessionIngestionService;
  let unsubs: UnsubscribeFunction[];
  let manager: SessionTurnManager | undefined;
  let bridge: SessionBridge | undefined;

  beforeEach(() => {
    resetBusHandlers();
    unsubs = [
      registerMemorySessionStorage(MakaioBus),
      registerMemorySessionEventStorage(MakaioBus),
      registerMemoryTurnStorage(MakaioBus),
      registerMemoryMessageStorage(MakaioBus),
    ];
    service = new ObservedSessionIngestionService(MakaioBus);
  });

  afterEach(() => {
    service.destroy();
    manager?.destroy();
    bridge?.destroy();
    manager = undefined;
    bridge = undefined;
    unsubs.forEach((unsub) => unsub());
    resetBusHandlers();
  });

  it('AC1: an observed session appears and fires contract-satisfying turn events with marker live', async () => {
    stubLogImportService(unsubs, buildTranscript());
    const snapshots = collectContractSnapshots(unsubs);
    const createdCounter = countSessionCreated(unsubs);

    await emitObservedTurnFlow();
    // session.created is emitted fire-and-forget by the registration seam.
    await waitForAsync();

    expect(snapshots).toHaveLength(2);
    for (const snapshot of snapshots) {
      // Point 1 (at emission time): session row exists with observed identity.
      expect(snapshot.session).not.toBeNull();
      expect(snapshot.session?.source).toBe(ADAPTER_NAME);
      expect(snapshot.session?.importStatus).toBe('tracking');
      expect(snapshot.session?.metadata).toEqual({ consumer: 'v' });

      // Point 2 (at emission time): turn row completed.
      expect(snapshot.turn?.status).toBe('completed');
      expect(snapshot.turn?.turnNumber).toBe(snapshot.payload.turnNumber);

      // Point 3 (at emission time): messages queryable via getByTurn.
      expect(snapshot.messages).toHaveLength(2);
      expect(snapshot.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
      expect(snapshot.messages.every((message) => message.turnId === snapshot.payload.turnId)).toBe(true);

      // Point 4: payload carries the full consumer contract, marker 'live'.
      expect(snapshot.payload.sessionId).toBe(snapshot.session?.sessionId);
      expect(snapshot.payload.turnId).toBeTruthy();
      expect(snapshot.payload.turnNumber).toBeGreaterThanOrEqual(1);
      expect(snapshot.payload.success).toBe(true);
      expect(snapshot.payload.ingestionMarker).toBe('live');
    }
    expect(snapshots.map((snapshot) => snapshot.payload.turnNumber)).toEqual([1, 2]);

    // Exactly one session.created across hook-first registration + import enrichment.
    expect(createdCounter.count).toBe(1);
  });

  it('AC8: adapter-managed sessions produce no registration, no import trigger, and no turn events', async () => {
    const importFileRequests = stubLogImportService(unsubs, buildTranscript());
    const started = collectTurnStartedEvents(unsubs);
    const completed = collectTurnCompletedEvents(unsubs);

    await MakaioBus.emit(ClientSubjects.runtime.started, {
      clientRuntimeId: 'rt-ext-2',
      clientId: CLIENT_ID,
      status: 'started',
      source: { layer: 'adapter', producer: 'test-producer' },
      observedAt: 500,
      adapterSessionId: 'ext-2',
    });
    await emitObservedTurnFlow('ext-2');
    await waitForAsync();

    const { sessions } = await MakaioBus.request(SessionStorageSubjects.listImported, {});
    expect(sessions).toEqual([]);
    expect(importFileRequests).toEqual([]);
    expect(started.received).toEqual([]);
    expect(completed.received).toEqual([]);
  });

  it('AC11: the ingest seam writes turn.started and turn.completed lifecycle rows into session_events', async () => {
    stubLogImportService(unsubs, buildTranscript());

    await emitObservedTurnFlow();

    const { session } = await MakaioBus.request(SessionStorageSubjects.getByAdapterSessionId, {
      adapterSessionId: ADAPTER_SESSION_ID,
      source: ADAPTER_NAME,
    });
    expect(session).not.toBeNull();
    const sessionId = session?.sessionId ?? '';

    const events = await getStoredEvents(sessionId);
    // One lifecycle row pair per ingested turn (two turns in the transcript).
    expect(events.filter((event) => event.type === 'turn.started')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'turn.completed')).toHaveLength(2);
  });

  it("AC6: the managed path stamps marker 'live' and satisfies the contract at integration level", async () => {
    // The persist-before-emit ordering under artificial storage latency is
    // covered exhaustively by turn-completion-barrier.test.ts; this scenario
    // only verifies the marker and at-event-time message visibility with the
    // real memory storage in the loop.
    const snapshots = collectContractSnapshots(unsubs);

    manager = new SessionTurnManager(MakaioBus);
    manager.registerCompletionHandlers(manager.completeTurn.bind(manager));
    bridge = new SessionBridge(MakaioBus);

    const sessionId = 'managed-session';
    const turn = await manager.createTurn(sessionId, ['agent-1']);
    turn.addMessage('msg-user-1');
    // Prime SessionBridge turn tracking (normally emitted by the orchestrator).
    await MakaioBus.emit(SessionSubjects.turn.started, {
      sessionId,
      turnId: turn.turnId,
      turnNumber: turn.turnNumber,
      messageId: 'msg-user-1',
      agentIds: ['agent-1'],
      ingestionMarker: 'live',
    });
    await MakaioBus.emit(AgentSubjects.message, {
      agentId: 'agent-1',
      adapterId: 'adapter-agent-1',
      adapterName: 'test-adapter',
      adapterSessionId: 'native-agent-1',
      messageId: 'msg-agent-1',
      content: 'hello from the managed agent',
    });
    await MakaioBus.emit(AgentSubjects.complete, {
      agentId: 'agent-1',
      adapterId: 'adapter-agent-1',
      adapterName: 'test-adapter',
      adapterSessionId: 'native-agent-1',
      turnId: turn.turnId,
      messageId: 'msg-agent-1',
    });
    await waitForAsync();

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].payload.ingestionMarker).toBe('live');
    expect(snapshots[0].payload.turnId).toBe(turn.turnId);
    // Persistence completed before emission: the assistant message is already
    // visible via getByTurn inside the turn.completed subscriber.
    expect(snapshots[0].messages.some((message) => message.role === 'assistant')).toBe(true);
  });

  it('re-triggering the same observed turn re-ingests idempotently: no new events, rows, or numbers', async () => {
    const importFileRequests = stubLogImportService(unsubs, buildTranscript());
    const started = collectTurnStartedEvents(unsubs);
    const completed = collectTurnCompletedEvents(unsubs);

    await emitObservedTurnFlow();
    expect(started.received).toHaveLength(2);
    expect(completed.received).toHaveLength(2);
    const firstRun = completed.received.map(({ turnId, turnNumber }) => ({ turnId, turnNumber }));
    started.clear();
    completed.clear();

    // Second identical Stop-hook observation: the stub re-parses the same
    // transcript and re-feeds both turns through the ingest seam.
    await MakaioBus.emit(ClientSubjects.session.turn.completed, {
      clientId: CLIENT_ID,
      source: 'native-hook',
      observedAt: 3_000,
      adapterSessionId: ADAPTER_SESSION_ID,
      transcriptPath: TRANSCRIPT_PATH,
    });
    await waitForAsync();

    expect(importFileRequests).toHaveLength(2);
    expect(started.received).toEqual([]);
    expect(completed.received).toEqual([]);

    const { session } = await MakaioBus.request(SessionStorageSubjects.getByAdapterSessionId, {
      adapterSessionId: ADAPTER_SESSION_ID,
      source: ADAPTER_NAME,
    });
    const { turns } = await MakaioBus.request(TurnStorageSubjects.getBySession, {
      sessionId: session?.sessionId ?? '',
    });
    expect(turns.map(({ turnId, turnNumber }: Turn) => ({ turnId, turnNumber }))).toEqual(firstRun);
  });
});
