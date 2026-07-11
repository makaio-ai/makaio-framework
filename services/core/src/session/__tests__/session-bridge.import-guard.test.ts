import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects, SessionSubjects } from '@makaio/contracts';
import { SessionBridge } from '../session-bridge.js';
import { MessageStorageSubjects } from '../messages/namespace.js';

interface ImportedEventMetadata {
  source: string;
  tool: string;
  streaming: boolean;
}

interface ImportCompletePayload {
  agentId: string;
  adapterId: string;
  adapterName: string;
  adapterSessionId: string;
  messageId: string;
  turnId: string;
  outcome: 'completed';
  _import: ImportedEventMetadata;
}

interface ImportCompleteOverrides {
  adapterId?: string;
  adapterName?: string;
  adapterSessionId?: string;
  messageId?: string;
  turnId?: string;
}

interface TurnStartedPayload {
  sessionId: string;
  turnId: string;
  turnNumber: number;
  messageId: string;
  agentIds: string[];
}

interface AgentMessagePayload {
  agentId: string;
  adapterId: string;
  adapterName: string;
  adapterSessionId: string;
  sessionId: string;
  messageId: string;
  turnId: string;
  content: string;
}

interface AgentCompletePayload {
  agentId: string;
  adapterId: string;
  adapterName: string;
  adapterSessionId: string;
  messageId: string;
  turnId: string;
  outcome: 'completed';
}

interface PendingDeliveryFixture {
  sessionId: string;
  turnId: string;
  messageId: string;
  agentId: string;
  content: string;
}

const DEFAULT_IMPORT_COMPLETE_METADATA: ImportedEventMetadata = {
  source: 'external',
  tool: 'claude-code-cli',
  streaming: false,
};

const DEFAULT_IMPORT_COMPLETE_FIELDS = {
  adapterId: 'adapter-1',
  adapterName: 'claude-code-cli',
  adapterSessionId: 'native-session-1',
  messageId: 'msg-1',
  turnId: 'turn-1',
  outcome: 'completed' as const,
};

function registerAppendHandler(appendSpy: (payload: unknown) => void): () => void {
  return MakaioBus.on(MessageStorageSubjects.append, (ctx) => {
    appendSpy(ctx.payload);
    const message = ctx.payload?.message;
    if (!message || typeof message !== 'object' || typeof message.messageId !== 'string') {
      throw new Error('MessageStorageSubjects.append requires a payload.message.messageId');
    }
    ctx.setResult({
      message: {
        messageId: message.messageId,
        turnId: message.turnId,
        sessionId: message.sessionId,
        role: message.role,
        contentText: message.contentText,
        blocks: message.blocks,
        agentId: message.agentId,
        timestamp: message.timestamp,
      },
    });
  });
}

/**
 * Register message storage whose first append remains pending until released.
 * @param appendSpy - Records each append payload
 * @param onFirstAppend - Signals that the first append acquired its snapshot
 * @param waitForRelease - Promise that releases the first append
 * @returns Bus subscription cleanup
 */
function registerBlockingFirstAppendHandler(
  appendSpy: (payload: unknown) => void,
  onFirstAppend: () => void,
  waitForRelease: Promise<void>,
): () => void {
  let appendCount = 0;
  return MakaioBus.on(MessageStorageSubjects.append, async (ctx) => {
    appendCount += 1;
    appendSpy(ctx.payload);
    if (appendCount === 1) {
      onFirstAppend();
      await waitForRelease;
    }
    const message = ctx.payload.message;
    ctx.setResult({
      message: {
        ...message,
        messageId: message.messageId ?? crypto.randomUUID(),
        blocks: message.blocks ?? [],
      },
    });
  });
}

/**
 * Build a valid agent.complete payload and attach `_import` provenance metadata.
 *
 * `Object.assign` is used because TypeScript's excess-property check would
 * reject `_import` on an object literal; at runtime the bus passes the
 * original payload to handlers including any extra fields.
 * @param agentId - Agent identifier
 * @param overrides - Optional test-specific identifiers for correlation
 * @returns Payload with _import attached
 */
function makeImportCompletePayload(agentId: string, overrides: ImportCompleteOverrides = {}): ImportCompletePayload {
  const base = {
    agentId,
    ...DEFAULT_IMPORT_COMPLETE_FIELDS,
    ...overrides,
  };
  // Attach _import after construction — mirrors how BaseLogOrchestrator builds
  // NormalizedEvent payloads that include provenance metadata at runtime.
  return Object.assign(base, {
    _import: DEFAULT_IMPORT_COMPLETE_METADATA,
  });
}

function makeTurnStartedPayload(
  sessionId: string,
  turnId: string,
  messageId: string,
  agentIds: string[],
): TurnStartedPayload {
  return {
    sessionId,
    turnId,
    turnNumber: 1,
    messageId,
    agentIds,
  };
}

function buildAgentMessagePayload(overrides: Partial<AgentMessagePayload> = {}): AgentMessagePayload {
  return {
    agentId: 'default-agent',
    adapterId: 'adapter-1',
    adapterName: 'claude-code',
    adapterSessionId: 'native-session-default',
    sessionId: 'session-default',
    messageId: 'msg-default',
    turnId: 'turn-default',
    content: 'default content',
    ...overrides,
  };
}

function buildAgentCompletePayload(overrides: Partial<AgentCompletePayload> = {}): AgentCompletePayload {
  return {
    agentId: 'default-agent',
    adapterId: 'adapter-1',
    adapterName: 'claude-code',
    adapterSessionId: 'native-session-default',
    messageId: 'msg-default',
    turnId: 'turn-default',
    outcome: 'completed',
    ...overrides,
  };
}

async function seedPendingDelivery(
  delivery: PendingDeliveryFixture,
  ingestionMarker?: 'live' | 'backfill',
): Promise<void> {
  await MakaioBus.emit(SessionSubjects.turn.started, {
    ...makeTurnStartedPayload(delivery.sessionId, delivery.turnId, delivery.messageId, [delivery.agentId]),
    ...(ingestionMarker !== undefined && { ingestionMarker }),
  });
  await MakaioBus.emit(AgentSubjects.message, buildAgentMessagePayload(delivery));
}

async function emitDeliveryCompletion(delivery: PendingDeliveryFixture): Promise<void> {
  await MakaioBus.emit(AgentSubjects.complete, buildAgentCompletePayload(delivery));
}

function registerGetByTurnMock(cleanups: Array<() => void>): void {
  cleanups.push(
    MakaioBus.on(MessageStorageSubjects.getByTurn, (ctx) => {
      ctx.setResult({ messages: [] });
    }),
  );
}

describe('SessionBridge _import guard', () => {
  const cleanups: Array<() => void> = [];
  let bridge: SessionBridge;

  beforeEach(() => {
    bridge = new SessionBridge(MakaioBus);
  });

  afterEach(() => {
    bridge.destroy();
    const cleanupErrors: unknown[] = [];
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      try {
        cleanup?.();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      throw cleanupErrors[0];
    }
  });

  it('skips storage for agent.complete events with _import metadata', async () => {
    const appendSpy = vi.fn();
    const settlementSpy = vi.fn();

    cleanups.push(registerAppendHandler(appendSpy));
    cleanups.push(MakaioBus.on(SessionSubjects.turn.assistantPersistenceSettled, settlementSpy));
    registerGetByTurnMock(cleanups);

    // Establish agent context via turn.started so the bridge would normally try to store
    await MakaioBus.emit(
      SessionSubjects.turn.started,
      makeTurnStartedPayload('session-1', 'turn-1', 'user-msg-1', ['import-agent']),
    );

    await MakaioBus.emit(
      AgentSubjects.message,
      buildAgentMessagePayload({
        agentId: 'import-agent',
        adapterId: 'adapter-1',
        adapterName: 'claude-code-cli',
        adapterSessionId: 'native-session-1',
        sessionId: 'session-1',
        messageId: 'user-msg-1',
        turnId: 'turn-1',
        content: 'imported response',
      }),
    );

    // Emit agent.complete with _import metadata — SessionBridge must skip storage
    await MakaioBus.emit(
      AgentSubjects.complete,
      makeImportCompletePayload('import-agent', {
        adapterId: 'adapter-1',
        adapterName: 'claude-code-cli',
        adapterSessionId: 'native-session-1',
        messageId: 'user-msg-1',
      }),
    );

    expect(appendSpy).not.toHaveBeenCalled();
    expect(settlementSpy).not.toHaveBeenCalled();
  });

  it('does not leak imported blocks into a later live completion for the same delivery', async () => {
    const appendSpy = vi.fn();

    cleanups.push(registerAppendHandler(appendSpy));
    registerGetByTurnMock(cleanups);

    const delivery = {
      agentId: 'shared-agent',
      sessionId: 'session-imported',
      turnId: 'turn-imported',
      messageId: 'message-imported',
      content: 'imported content must not escape',
    };
    await seedPendingDelivery(delivery);

    await MakaioBus.emit(
      AgentSubjects.complete,
      makeImportCompletePayload('shared-agent', {
        turnId: 'turn-imported',
        messageId: 'message-imported',
      }),
    );
    await emitDeliveryCompletion(delivery);

    expect(appendSpy).not.toHaveBeenCalled();
  });

  it.each([
    'live',
    'backfill',
  ] as const)('clears %s turn accumulators when the imported lifecycle completes', async (ingestionMarker) => {
    const appendSpy = vi.fn();
    const settlementSpy = vi.fn();
    cleanups.push(registerAppendHandler(appendSpy));
    cleanups.push(MakaioBus.on(SessionSubjects.turn.assistantPersistenceSettled, settlementSpy));
    registerGetByTurnMock(cleanups);

    const delivery = {
      agentId: 'lifecycle-agent',
      sessionId: 'session-lifecycle',
      turnId: 'turn-lifecycle',
      messageId: 'message-lifecycle',
      content: 'completed lifecycle content',
    };
    await seedPendingDelivery(delivery, ingestionMarker);

    await MakaioBus.emit(SessionSubjects.turn.completed, {
      sessionId: 'session-lifecycle',
      turnId: 'turn-lifecycle',
      turnNumber: 1,
      success: true,
      ingestionMarker,
    });
    await emitDeliveryCompletion(delivery);

    expect(appendSpy).not.toHaveBeenCalled();
    expect(settlementSpy).not.toHaveBeenCalled();
  });

  it('clears turn completion by session and turn without consuming neighboring accumulators', async () => {
    const appendSpy = vi.fn();
    const settlementSpy = vi.fn();
    cleanups.push(registerAppendHandler(appendSpy));
    cleanups.push(MakaioBus.on(SessionSubjects.turn.assistantPersistenceSettled, settlementSpy));
    registerGetByTurnMock(cleanups);

    const deliveries = [
      {
        sessionId: 'session-target',
        turnId: 'turn-shared',
        messageId: 'message-target',
        agentId: 'agent-target',
        content: 'target content',
      },
      {
        sessionId: 'session-target',
        turnId: 'turn-neighbor',
        messageId: 'message-neighbor-turn',
        agentId: 'agent-neighbor-turn',
        content: 'neighbor turn content',
      },
      {
        sessionId: 'session-neighbor',
        turnId: 'turn-shared',
        messageId: 'message-neighbor-session',
        agentId: 'agent-neighbor-session',
        content: 'neighbor session content',
      },
    ] as const;

    for (const delivery of deliveries) {
      await seedPendingDelivery(delivery);
    }

    await MakaioBus.emit(SessionSubjects.turn.completed, {
      sessionId: deliveries[0].sessionId,
      turnId: deliveries[0].turnId,
      turnNumber: 1,
      success: true,
      ingestionMarker: 'backfill',
    });
    await emitDeliveryCompletion(deliveries[0]);

    expect(appendSpy).not.toHaveBeenCalled();
    expect(settlementSpy).not.toHaveBeenCalled();

    await emitDeliveryCompletion(deliveries[1]);
    await emitDeliveryCompletion(deliveries[2]);

    expect(appendSpy.mock.calls.map(([payload]) => payload.message.blocks)).toEqual([
      [{ type: 'text', content: 'neighbor turn content' }],
      [{ type: 'text', content: 'neighbor session content' }],
    ]);
    expect(settlementSpy).toHaveBeenCalledTimes(2);
  });

  it('clears session-owned accumulators without requiring an agent mapping', async () => {
    const appendSpy = vi.fn();
    const settlementSpy = vi.fn();
    cleanups.push(registerAppendHandler(appendSpy));
    cleanups.push(MakaioBus.on(SessionSubjects.turn.assistantPersistenceSettled, settlementSpy));
    registerGetByTurnMock(cleanups);

    const delivery = {
      agentId: 'unmapped-agent',
      sessionId: 'session-closed',
      turnId: 'turn-closed',
      messageId: 'message-closed',
      content: 'closed session content',
    };
    await seedPendingDelivery(delivery);

    await MakaioBus.emit(SessionSubjects.closed, { sessionId: 'session-closed' });
    await emitDeliveryCompletion(delivery);

    expect(appendSpy).not.toHaveBeenCalled();
    expect(settlementSpy).not.toHaveBeenCalled();
  });

  it('stores normally for agent.complete events without _import metadata', async () => {
    const appendSpy = vi.fn();

    cleanups.push(registerAppendHandler(appendSpy));
    registerGetByTurnMock(cleanups);

    // Establish agent context
    await MakaioBus.emit(
      SessionSubjects.turn.started,
      makeTurnStartedPayload('session-2', 'turn-2', 'user-msg-2', ['live-agent']),
    );

    // Accumulate a text block so storeAssistantMessage doesn't bail on empty blocks
    await MakaioBus.emit(
      AgentSubjects.message,
      buildAgentMessagePayload({
        agentId: 'live-agent',
        adapterId: 'adapter-1',
        adapterName: 'claude-code',
        adapterSessionId: 'native-session-2',
        sessionId: 'session-2',
        messageId: 'user-msg-2',
        turnId: 'turn-2',
        content: 'response text',
      }),
    );

    // Emit agent.complete without _import metadata — SessionBridge must store
    await MakaioBus.emit(
      AgentSubjects.complete,
      buildAgentCompletePayload({
        agentId: 'live-agent',
        adapterId: 'adapter-1',
        adapterName: 'claude-code',
        adapterSessionId: 'native-session-2',
        messageId: 'user-msg-2',
        turnId: 'turn-2',
        outcome: 'completed',
      }),
    );

    expect(appendSpy).toHaveBeenCalledTimes(1);
  });

  it('starts a fresh accumulator for the next live turn after an imported completion', async () => {
    const appendSpy = vi.fn();

    cleanups.push(registerAppendHandler(appendSpy));
    registerGetByTurnMock(cleanups);

    await MakaioBus.emit(
      SessionSubjects.turn.started,
      makeTurnStartedPayload('session-3', 'turn-3', 'user-msg-3', ['shared-agent']),
    );

    await MakaioBus.emit(
      AgentSubjects.message,
      buildAgentMessagePayload({
        agentId: 'shared-agent',
        adapterId: 'adapter-1',
        adapterName: 'claude-code',
        adapterSessionId: 'native-session-imported',
        sessionId: 'session-3',
        messageId: 'user-msg-3',
        turnId: 'turn-3',
        content: 'imported content',
      }),
    );

    await MakaioBus.emit(
      AgentSubjects.complete,
      makeImportCompletePayload('shared-agent', {
        adapterId: 'adapter-1',
        adapterName: 'claude-code',
        adapterSessionId: 'native-session-imported',
        messageId: 'user-msg-3',
        turnId: 'turn-3',
      }),
    );

    await MakaioBus.emit(SessionSubjects.user_message.acknowledged, {
      agentId: 'shared-agent',
      sessionId: 'session-4',
      turnId: 'turn-4',
      turnNumber: 1,
      messageId: 'user-msg-4',
    });

    await MakaioBus.emit(
      AgentSubjects.message,
      buildAgentMessagePayload({
        agentId: 'shared-agent',
        adapterId: 'adapter-1',
        adapterName: 'claude-code',
        adapterSessionId: 'native-session-live',
        sessionId: 'session-4',
        messageId: 'user-msg-4',
        turnId: 'turn-4',
        content: 'live content',
      }),
    );

    await MakaioBus.emit(
      AgentSubjects.complete,
      buildAgentCompletePayload({
        agentId: 'shared-agent',
        adapterId: 'adapter-1',
        adapterName: 'claude-code',
        adapterSessionId: 'native-session-live',
        messageId: 'user-msg-4',
        turnId: 'turn-4',
        outcome: 'completed',
      }),
    );

    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy.mock.calls[0][0].message.blocks).toEqual([{ type: 'text', content: 'live content' }]);
  });

  it('ignores a late completion for the prior turn without consuming the current response', async () => {
    const appendSpy = vi.fn();
    cleanups.push(registerAppendHandler(appendSpy));
    registerGetByTurnMock(cleanups);

    await MakaioBus.emit(
      SessionSubjects.turn.started,
      makeTurnStartedPayload('session-late', 'turn-old', 'user-old', ['shared-agent']),
    );
    await MakaioBus.emit(
      SessionSubjects.turn.started,
      makeTurnStartedPayload('session-late', 'turn-current', 'user-current', ['shared-agent']),
    );
    await MakaioBus.emit(
      AgentSubjects.message,
      buildAgentMessagePayload({
        agentId: 'shared-agent',
        sessionId: 'session-late',
        turnId: 'turn-current',
        messageId: 'user-current',
        content: 'current response',
      }),
    );

    await MakaioBus.emit(
      AgentSubjects.complete,
      buildAgentCompletePayload({
        agentId: 'shared-agent',
        turnId: 'turn-old',
        messageId: 'user-old',
      }),
    );
    expect(appendSpy).not.toHaveBeenCalled();

    await MakaioBus.emit(
      AgentSubjects.complete,
      buildAgentCompletePayload({
        agentId: 'shared-agent',
        turnId: 'turn-current',
        messageId: 'user-current',
      }),
    );

    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy.mock.calls[0][0].message).toMatchObject({
      turnId: 'turn-current',
      blocks: [{ type: 'text', content: 'current response' }],
    });
  });

  it('persists overlapping turns from detached snapshots without erasing new-turn blocks', async () => {
    const appendSpy = vi.fn();
    let signalFirstAppend!: () => void;
    const firstAppendStarted = new Promise<void>((resolve) => {
      signalFirstAppend = resolve;
    });
    let releaseFirstAppend!: () => void;
    const firstAppendRelease = new Promise<void>((resolve) => {
      releaseFirstAppend = resolve;
    });
    cleanups.push(registerBlockingFirstAppendHandler(appendSpy, signalFirstAppend, firstAppendRelease));
    registerGetByTurnMock(cleanups);

    await MakaioBus.emit(
      SessionSubjects.turn.started,
      makeTurnStartedPayload('session-overlap', 'turn-1', 'user-1', ['shared-agent']),
    );
    await MakaioBus.emit(
      AgentSubjects.message,
      buildAgentMessagePayload({
        agentId: 'shared-agent',
        sessionId: 'session-overlap',
        turnId: 'turn-1',
        messageId: 'user-1',
        content: 'first response',
      }),
    );

    const firstCompletion = MakaioBus.emit(
      AgentSubjects.complete,
      buildAgentCompletePayload({ agentId: 'shared-agent', turnId: 'turn-1', messageId: 'user-1' }),
    );
    await firstAppendStarted;

    await MakaioBus.emit(
      SessionSubjects.turn.started,
      makeTurnStartedPayload('session-overlap', 'turn-2', 'user-2', ['shared-agent']),
    );
    await MakaioBus.emit(
      AgentSubjects.message,
      buildAgentMessagePayload({
        agentId: 'shared-agent',
        sessionId: 'session-overlap',
        turnId: 'turn-2',
        messageId: 'user-2',
        content: 'second response',
      }),
    );

    releaseFirstAppend();
    await firstCompletion;
    await MakaioBus.emit(
      AgentSubjects.complete,
      buildAgentCompletePayload({ agentId: 'shared-agent', turnId: 'turn-2', messageId: 'user-2' }),
    );

    expect(appendSpy).toHaveBeenCalledTimes(2);
    expect(appendSpy.mock.calls.map(([payload]) => payload.message.turnId)).toEqual(['turn-1', 'turn-2']);
    expect(appendSpy.mock.calls.map(([payload]) => payload.message.blocks)).toEqual([
      [{ type: 'text', content: 'first response' }],
      [{ type: 'text', content: 'second response' }],
    ]);
  });
});
