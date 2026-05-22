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
  outcome: 'completed';
  _import: ImportedEventMetadata;
}

interface ImportCompleteOverrides {
  adapterId?: string;
  adapterName?: string;
  adapterSessionId?: string;
  messageId?: string;
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
  content: string;
}

interface AgentCompletePayload {
  agentId: string;
  adapterId: string;
  adapterName: string;
  adapterSessionId: string;
  messageId: string;
  outcome: 'completed';
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
    outcome: 'completed',
    ...overrides,
  };
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

    cleanups.push(registerAppendHandler(appendSpy));
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
        outcome: 'completed',
      }),
    );

    expect(appendSpy).toHaveBeenCalledTimes(1);
  });

  it('clears imported blocks before the next live completion for the same agent', async () => {
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
        outcome: 'completed',
      }),
    );

    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy.mock.calls[0][0].message.blocks).toEqual([{ type: 'text', content: 'live content' }]);
  });
});
