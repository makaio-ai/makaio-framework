/**
 * Test utilities for the services-session package.
 * Includes mock handlers and shared schema installers for session-focused tests.
 */
import { MakaioBus } from '@makaio/bus-core';
import { buildStoredCredentialRef } from '@makaio/contracts/config';
import { ProviderStorageSubjects } from '../../settings/storage/providers-namespace.js';
import { AdapterSubsystemSubjects } from '../../adapter-subsystem/namespace.js';
import { ExecutionTargetSubjects } from '../../execution-target/namespace.js';
import { TurnStorageSubjects, MessageStorageSubjects, MessageRoutingSubjects } from '../index.js';
import { SessionStorageSubjects } from '../storage/namespace.js';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';
import { SessionEventStorageSubjects } from '../session-events/namespace.js';
import { DEFAULT_TEST_MACHINE_ID, registerMockAdapterIdentityHandlers } from './mock-adapter-identity-registry.js';
export { SESSION_STORAGE_TEST_SCHEMA_SQL, installSessionStorageTestSchema } from './storage-test-schema.js';

/**
 * Register mock storage handlers for framework-core storage subjects.
 * Covers turns, messages, routing, adapters, agents, and session context.
 * Required for tests that use turn/message storage without a real database.
 * @returns Unsubscribe function to clean up handlers
 */
export function registerMockStorageHandlers(): () => void {
  const unsubs: Array<() => void> = [];
  registerTurnHandlers(unsubs);
  registerMessageHandlers(unsubs);
  registerRoutingHandlers(unsubs);
  registerAdapterHandlers(unsubs);
  registerAgentHandlers(unsubs);
  registerSessionContextHandlers(unsubs);
  return () => unsubs.forEach((u) => u());
}

/**
 * Register mock provider and execution target handlers.
 * Covers AdapterSubsystemSubjects.getProviderConfig,
 * AdapterSubsystemSubjects.buildProviderContext, ProviderStorageSubjects, and
 * ExecutionTargetSubjects.
 * Required for platform tests that exercise provider resolution or execution
 * target routing.
 * @returns Unsubscribe function to clean up handlers
 */
export function registerMockProviderHandlers(): () => void {
  const unsubs: Array<() => void> = [];
  registerExecutionTargetHandlers(unsubs);
  registerProviderHandlers(unsubs);
  return () => unsubs.forEach((u) => u());
}

/**
 * Register mock turn storage handlers.
 * @param unsubs - Array to collect cleanup functions
 */
function registerTurnHandlers(unsubs: Array<() => void>): void {
  /** Monotonic per-session turn counter: sessionId → next turn number. */
  const nextTurnNumberBySession = new Map<string, number>();
  /** Turn metadata indexed by turnId for round-trip fidelity in complete. */
  const turnsById = new Map<string, { sessionId: string; turnNumber: number; startedAt: number }>();

  unsubs.push(
    MakaioBus.on(TurnStorageSubjects.create, (ctx) => {
      const { sessionId } = ctx.payload;
      const turnNumber = (nextTurnNumberBySession.get(sessionId) ?? 0) + 1;
      nextTurnNumberBySession.set(sessionId, turnNumber);
      const turnId = ctx.payload.turnId ?? crypto.randomUUID();
      const startedAt = Date.now();
      turnsById.set(turnId, { sessionId, turnNumber, startedAt });
      ctx.setResult({
        turn: {
          turnId,
          sessionId,
          turnNumber,
          startedAt,
          status: 'active',
        },
      });
    }),
  );

  unsubs.push(
    MakaioBus.on(TurnStorageSubjects.complete, (ctx) => {
      const stored = turnsById.get(ctx.payload.turnId);
      if (!stored) {
        throw new Error(`Mock turn ${ctx.payload.turnId} was not created before completion`);
      }
      ctx.setResult({
        turn: {
          turnId: ctx.payload.turnId,
          sessionId: stored.sessionId,
          turnNumber: stored.turnNumber,
          startedAt: stored.startedAt,
          completedAt: Date.now(),
          status: ctx.payload.status,
          error: ctx.payload.error,
          usage: ctx.payload.usage,
        },
        transitioned: true,
      });
    }),
  );

  unsubs.push(
    MakaioBus.on(TurnStorageSubjects.set, (ctx) => {
      const { turn } = ctx.payload;
      turnsById.set(turn.turnId, {
        sessionId: turn.sessionId,
        turnNumber: turn.turnNumber,
        startedAt: turn.startedAt,
      });
      nextTurnNumberBySession.set(
        turn.sessionId,
        Math.max(nextTurnNumberBySession.get(turn.sessionId) ?? 0, turn.turnNumber),
      );
      ctx.setResult({ turn });
    }),
  );

  unsubs.push(
    MakaioBus.on(TurnStorageSubjects.getBySession, (ctx) => {
      ctx.setResult({ turns: [] });
    }),
  );
}

/**
 * Register mock message storage handlers.
 * @param unsubs - Array to collect cleanup functions
 */
function registerMessageHandlers(unsubs: Array<() => void>): void {
  unsubs.push(
    MakaioBus.on(MessageStorageSubjects.append, (ctx) => {
      const { message } = ctx.payload;
      ctx.setResult({
        message: {
          messageId: message.messageId ?? `msg-${crypto.randomUUID().slice(0, 8)}`,
          turnId: message.turnId,
          sessionId: message.sessionId,
          role: message.role,
          contentText: message.contentText,
          blocks: message.blocks,
          agentId: message.agentId,
          adapterSessionId: message.adapterSessionId,
          adapterMessageId: message.adapterMessageId,
          timestamp: message.timestamp,
          editOf: message.editOf,
        },
      });
    }),
  );

  unsubs.push(
    MakaioBus.on(MessageStorageSubjects.getByTurn, (ctx) => {
      ctx.setResult({ messages: [] });
    }),
  );

  unsubs.push(
    MakaioBus.on(MessageStorageSubjects.getBySession, (ctx) => {
      ctx.setResult({ messages: [], nextCursor: null });
    }),
  );
}

/**
 * Register mock message routing handlers.
 * @param unsubs - Array to collect cleanup functions
 */
function registerRoutingHandlers(unsubs: Array<() => void>): void {
  unsubs.push(
    MakaioBus.on(MessageRoutingSubjects.record, (ctx) => {
      ctx.setResult({ success: true });
    }),
  );

  unsubs.push(
    MakaioBus.on(MessageRoutingSubjects.getByMessage, (ctx) => {
      ctx.setResult({ routing: [] });
    }),
  );
}

/**
 * Register mock adapter storage handlers.
 * @param unsubs - Array to collect cleanup functions
 */
function registerAdapterHandlers(unsubs: Array<() => void>): void {
  unsubs.push(registerMockAdapterIdentityHandlers(DEFAULT_TEST_MACHINE_ID).unsubscribe);
}

/**
 * Register mock agent storage handlers.
 * @param unsubs - Array to collect cleanup functions
 */
function registerAgentHandlers(unsubs: Array<() => void>): void {
  unsubs.push(
    MakaioBus.on(AgentStorageSubjects.set, (ctx) => {
      ctx.setResult({ success: true });
    }),
  );

  unsubs.push(
    MakaioBus.on(AgentStorageSubjects.get, (ctx) => {
      ctx.setResult({ agent: null });
    }),
  );

  unsubs.push(
    MakaioBus.on(AgentStorageSubjects.listBySession, (ctx) => {
      ctx.setResult({ agents: [] });
    }),
  );
}

/**
 * Register mock session context handlers for recovery flows.
 * Required by buildRecoveryContext → getFullConversation → buildSessionContext.
 * @param unsubs - Array to collect cleanup functions
 */
function registerSessionContextHandlers(unsubs: Array<() => void>): void {
  // getFullConversation traverses parent chain via SessionStorageSubjects.get
  unsubs.push(
    MakaioBus.on(SessionStorageSubjects.get, (ctx) => {
      // Return a minimal root session (no parent) to stop chain traversal
      ctx.setResult({
        session: {
          sessionId: ctx.payload.sessionId,
          createdAt: Date.now(),
          lastActivityAt: Date.now(),
          status: 'active',
          agents: [],
        },
      });
    }),
  );

  // buildSessionContext fetches events for message assembly
  unsubs.push(
    MakaioBus.on(SessionEventStorageSubjects.getEvents, (ctx) => {
      ctx.setResult({ events: [], nextCursor: null, totalCount: 0 });
    }),
  );

  // buildSessionContext fetches individual messages by ID
  unsubs.push(
    MakaioBus.on(MessageStorageSubjects.get, (ctx) => {
      ctx.setResult({ message: null });
    }),
  );

  // Partial session updates (e.g., stamping executionTargetId after resolution)
  unsubs.push(
    MakaioBus.on(SessionStorageSubjects.update, (ctx) => {
      ctx.setResult({ success: true });
    }),
  );
}

/**
 * Register mock execution target handlers.
 * Returns the system default local target for all resolution requests.
 * @param unsubs - Array to collect cleanup functions
 */
function registerExecutionTargetHandlers(unsubs: Array<() => void>): void {
  unsubs.push(
    MakaioBus.on(ExecutionTargetSubjects.resolve, (ctx) => {
      ctx.setResult({
        executionTarget: {
          id: 'system:local',
          name: 'Local',
          description: 'Default local process execution',
          type: 'local',
          scope: 'default',
          enabled: true,
          createdAt: 0,
          updatedAt: 0,
        },
      });
    }),
  );
}

/**
 * Register mock provider config and definition handlers.
 *
 * Returns a minimal stub ProviderConfig and ProviderDefinition so that
 * {@link buildProviderContext} succeeds in tests that include a `providerConfigId`
 * without registering their own storage handlers. Tests that need specific
 * provider data should override these with higher-priority handlers.
 * @param unsubs - Array to collect cleanup functions
 */
function registerProviderHandlers(unsubs: Array<() => void>): void {
  unsubs.push(
    MakaioBus.on(AdapterSubsystemSubjects.getProviderConfig, (ctx) => {
      ctx.setResult({
        config: {
          id: ctx.payload.id,
          definitionId: 'test-provider',
          name: 'Test Provider',
          modelFilterMode: 'show-all' as const,
          isDefault: false,
          enabled: true,
          isSentinel: false,
          hasCredentials: true,
        },
      });
    }),
  );

  unsubs.push(
    MakaioBus.on(AdapterSubsystemSubjects.buildProviderContext, (ctx) => {
      ctx.setResult({
        context: {
          providerConfigId: ctx.payload.providerConfigId,
          definitionId: 'test-provider',
          credentialRefs: {
            apiKey: buildStoredCredentialRef(ctx.payload.providerConfigId, 'apiKey'),
          },
          credentialEnvVars: {
            apiKey: 'API_KEY',
          },
        },
      });
    }),
  );

  unsubs.push(
    MakaioBus.on(ProviderStorageSubjects.get, (ctx) => {
      ctx.setResult({
        provider: {
          id: ctx.payload.id,
          packageName: '@makaio/test-provider',
          name: 'Test Provider',
          availableModels: [],
          defaultModelFilterMode: 'show-all' as const,
          enabled: true,
          createdAt: 0,
          updatedAt: 0,
        },
      });
    }),
  );
}
