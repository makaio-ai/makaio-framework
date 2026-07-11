import { MakaioBus } from '@makaio/bus-core';
import {
  AdapterSubjects,
  AgentSubjects,
  SessionEventStorageSubjects,
  SessionStorageSubjects,
  SessionSubjects,
} from '@makaio/contracts';
import type { IMakaioSession, StartAgentResponse } from '@makaio/contracts';
import type { ExtractSubjectPayload } from '@makaio/core';
import { Turn } from '../../entities/turn.js';
import { SessionTurnManager } from '../../session-turn-manager.js';
import { registerAttachHandler } from '../attach-handler.js';
import { registerForkHandler } from '../fork-handler.js';
import { routeToAgents, type RouteToAgentsOptions } from '../route-to-agents.js';
import { MessageStorageSubjects } from '../../messages/namespace.js';
import { AgentStorageSubjects } from '../../storage/agent-namespace.js';
import { recordTurnPairCompletion, type TurnCompletionEventHooks } from '../../turn-completion-events.js';
import { TurnStorageSubjects } from '../../turns/index.js';
import { resetBusHandlers } from '../../__tests__/shared.js';
import {
  DEFAULT_TEST_MACHINE_ID,
  registerMockAdapterIdentityHandlers,
} from '../../testing/mock-adapter-identity-registry.js';

/**
 * Registers a mock handler for agent.sendMessage that succeeds.
 * @returns Unsubscribe function to remove the handler
 */
export function registerSuccessfulSendHandler(): () => void {
  return MakaioBus.on(AgentSubjects.sendMessage, (context) => {
    context.setResult({ messageId: context.payload.messageId ?? 'generated-id' });
  });
}

/**
 * Registers a mock handler for agent.sendMessage that fails for specific agents.
 * @param failingAgentIds - Set of agent IDs that should fail
 * @param errorMessage - Error message to throw
 * @returns Unsubscribe function to remove the handler
 */
export function registerFailingSendHandler(failingAgentIds: Set<string>, errorMessage: string): () => void {
  return MakaioBus.on(AgentSubjects.sendMessage, (context) => {
    if (failingAgentIds.has(context.payload.agentId)) {
      throw new Error(errorMessage);
    }
    context.setResult({ messageId: context.payload.messageId ?? 'generated-id' });
  });
}

/** Payload accepted by the message append storage subject. */
export type MessageAppendPayload = ExtractSubjectPayload<typeof MessageStorageSubjects.append>;

/** Options for the successful message append test fixture. */
export interface SuccessfulMessageAppendHandlerOptions {
  priority?: number;
  onAppend?: (payload: MessageAppendPayload) => void;
}

/**
 * Registers a message append handler that persists the supplied message shape.
 * @param options - Optional registration priority and append observer
 * @returns Unsubscribe function to remove the handler
 */
export function registerSuccessfulMessageAppendHandler(
  options: SuccessfulMessageAppendHandlerOptions = {},
): () => void {
  return MakaioBus.on(
    MessageStorageSubjects.append,
    (context) => {
      options.onAppend?.(context.payload);
      context.setResult({
        message: {
          ...context.payload.message,
          messageId: context.payload.message.messageId ?? crypto.randomUUID(),
        },
      });
    },
    options.priority === undefined ? undefined : { priority: options.priority },
  );
}

// =============================================================================
// Route-to-Agents Test Context
// =============================================================================

/** Default test IDs used across route-to-agents test files. */
export const ROUTE_TEST_IDS = {
  sessionId: 'session-123',
  messageId: 'msg-456',
  turnId: 'turn-789',
  testMessage: 'Hello, agent!',
} as const;

/**
 * Creates a test context for route-to-agents tests.
 * Encapsulates the repeated lifecycle: resetBusHandlers, unsubscribers, trackUnsubscribe.
 * @returns Context with trackUnsubscribe helper and destroy
 */
export function createRouteTestContext(): RouteTestContext {
  resetBusHandlers();
  const unsubscribers: Array<() => void> = [];

  return {
    ...ROUTE_TEST_IDS,
    trackUnsubscribe(unsub: () => void): void {
      unsubscribers.push(unsub);
    },
    destroy(): void {
      for (const unsub of unsubscribers) {
        unsub();
      }
      unsubscribers.length = 0;
    },
  };
}

/** Test context for route-to-agents tests. */
export interface RouteTestContext {
  readonly sessionId: string;
  readonly messageId: string;
  readonly turnId: string;
  readonly testMessage: string;
  trackUnsubscribe: (unsub: () => void) => void;
  destroy: () => void;
}

/**
 * Routes a message with a ledger-backed completion fixture matching production sequencing.
 * @param options - Route options with the real turn manager dependency omitted
 * @returns Promise resolved after all agent deliveries and turn completion work settle
 */
export async function routeToAgentsWithTestLedger(options: Omit<RouteToAgentsOptions, 'turnManager'>): Promise<void> {
  if (!options.turn.messageIds.includes(options.messageId)) {
    options.turn.admitMessage(
      options.messageId,
      options.agents.map((agent) => agent.agentId),
    );
    options.turn.commitMessageAdmission(options.messageId);
  }

  const hooks: TurnCompletionEventHooks = {
    resolveUsageTurn: () => undefined,
    resolveCompletionTurn: (turnId) => (turnId === options.turn.turnId ? options.turn : undefined),
    isCompletionInFlight: () => false,
    addUsage: () => undefined,
    bufferUsage: () => undefined,
    canRetry: () => false,
    retry: async () => undefined,
    beginFinalization: () => undefined,
  };

  await routeToAgents({
    ...options,
    turnManager: {
      recordAgentCompletion: async (agentId, messageId, outcome, error, onTurnComplete, turnId) => {
        await recordTurnPairCompletion(options.bus, hooks, {
          agentId,
          messageId,
          outcome,
          ...(error === undefined ? {} : { error }),
          turnId,
          onTurnComplete,
        });
      },
    },
  });
}

// =============================================================================
// Attach Handler Test Context
// =============================================================================

/** Default test IDs used across all attach handler test files. */
export const ATTACH_TEST_IDS = {
  sessionId: 'session-123',
  adapterName: 'adapter-456',
  agentId: 'agent-789',
  adapterSessionId: 'adapter-session-101',
  messageId: 'msg-001',
} as const;

/** Payload type for adapter.startAgent requests. */
export type StartAgentRequestPayload = ExtractSubjectPayload<typeof AdapterSubjects.startAgent>;
export type SessionCreateRequestPayload = ExtractSubjectPayload<typeof SessionSubjects.create>;

/**
 * Registers the default conversation storage stubs required by non-native
 * attach paths that call `seedAttachContextWithHistory`.
 *
 * Both subjects return an empty conversation:
 * - `SessionStorageSubjects.get` — minimal root session (no `parentSessionId`)
 *   so the chain walk terminates immediately.
 * - `SessionEventStorageSubjects.getEvents` — empty event list with no cursor.
 *
 * Used by {@link createAttachHandlerContext} (at priority -100 so test-specific
 * handlers take precedence) and by tests that call `resetBusHandlers()` and
 * need to restore the stubs afterwards (at default priority).
 * @param trackUnsubscribe - Callback that records each unsubscribe handle for cleanup
 * @param options - Optional bus registration options (e.g. `{ priority: -100 }`)
 */
export function registerDefaultConversationStubs(
  trackUnsubscribe: (unsub: () => void) => void,
  options?: { priority?: number },
): void {
  trackUnsubscribe(
    MakaioBus.on(
      SessionStorageSubjects.get,
      (context) => {
        // Return a minimal root session (no parentSessionId) so chain walk terminates.
        context.setResult({
          session: {
            sessionId: context.payload.sessionId,
            createdAt: Date.now(),
            lastActivityAt: Date.now(),
            status: 'active',
            agents: [],
          },
        });
      },
      options,
    ),
  );
  trackUnsubscribe(
    MakaioBus.on(
      SessionEventStorageSubjects.getEvents,
      (context) => {
        context.setResult({ events: [], nextCursor: null });
      },
      options,
    ),
  );
}

/**
 * Creates a test context for registerAttachHandler tests.
 * Encapsulates the repeated setup: resetBusHandlers, turn manager, unsubscribers,
 * mock adapter resolver, and common mock registrations.
 * @param currentMachineId - Optional runtime-default machine for mock resolveId handling
 * @returns Context with turn lifecycle helpers and cleanup methods
 */
export function createAttachHandlerContext(currentMachineId?: string | null): AttachHandlerTestContext {
  resetBusHandlers();
  const turnManager = new SessionTurnManager(MakaioBus);
  const unsubscribers: Array<() => void> = [];
  const { registry: adapterIdentityRegistry, unsubscribe: unsubscribeAdapterIdentityRegistry } =
    registerMockAdapterIdentityHandlers(
      currentMachineId === null ? undefined : (currentMachineId ?? DEFAULT_TEST_MACHINE_ID),
    );
  unsubscribers.push(unsubscribeAdapterIdentityRegistry);
  // No-op stub for agent identity persistence: attach handler tests focus on
  // adapter routing and turn setup, not downstream agent storage.
  unsubscribers.push(
    MakaioBus.on(
      AgentStorageSubjects.set,
      /**
       * Acknowledge agent persistence writes in attach-handler tests.
       * @param context - Bus handler context for AgentStorageSubjects.set.
       */
      (context) => context.setResult({ success: true }),
    ),
  );
  // Stub for turn creation: setupTurnTracking calls TurnStorageSubjects.create
  // to obtain a monotonic turnNumber before emitting lifecycle events.
  // The counter is local to createAttachHandlerContext() so each test context
  // has its own independent sequence.
  const nextTurnNumberBySession = new Map<string, number>();
  unsubscribers.push(
    MakaioBus.on(TurnStorageSubjects.create, (context) => {
      const { sessionId } = context.payload;
      const turnNumber = (nextTurnNumberBySession.get(sessionId) ?? 0) + 1;
      nextTurnNumberBySession.set(sessionId, turnNumber);
      context.setResult({
        turn: {
          turnId: context.payload.turnId ?? crypto.randomUUID(),
          sessionId,
          turnNumber,
          startedAt: Date.now(),
          status: 'active',
        },
      });
    }),
  );

  // Mock adapter.getCapabilities handler. By default every adapter declares
  // 'session:resume' so existing tests that expect native resume continue to
  // pass. Tests that need a non-resume adapter call `setDefaultAdapterCapabilities`
  // before the attach request to change what all adapters declare.
  let defaultAdapterCapabilities: string[] = ['session:resume'];
  unsubscribers.push(
    MakaioBus.on(AdapterSubjects.getCapabilities, (context) => {
      context.setResult({ capabilities: defaultAdapterCapabilities, nativeTools: [] });
    }),
  );

  // Default conversation storage stubs for getFullConversation chain walk.
  // Non-native attach paths call seedAttachContextWithHistory which reads the
  // session chain via SessionStorageSubjects.get and events via
  // SessionEventStorageSubjects.getEvents. These defaults return an empty
  // conversation so existing tests that don't seed history pass unchanged.
  // Registered at low priority so test-specific handlers take precedence.
  registerDefaultConversationStubs((unsub) => unsubscribers.push(unsub), { priority: -100 });
  unsubscribers.push(
    MakaioBus.on(
      MessageStorageSubjects.get,
      (context) => {
        context.setResult({ message: null });
      },
      { priority: -100 },
    ),
  );

  const ids = ATTACH_TEST_IDS;

  return {
    turnManager,
    getActiveTurn(sessionId: string): Turn | undefined {
      return turnManager.getActiveTurn(sessionId);
    },

    /**
     * Tracks a cleanup function to be called on destroy.
     * @param unsub - Unsubscribe function to track
     */
    trackUnsubscribe(unsub: () => void): void {
      unsubscribers.push(unsub);
    },

    /**
     * Overrides the default capabilities returned by the mock
     * `getCapabilities` handler for all adapters.
     * @param capabilities - Capability tokens to declare
     */
    setDefaultAdapterCapabilities(capabilities: string[]): void {
      defaultAdapterCapabilities = capabilities;
    },

    /**
     * Creates a mock session for attach handler tests.
     * @param overrides - Optional overrides for session properties
     * @returns A IMakaioSession object
     */
    createMockSession(overrides?: Partial<IMakaioSession>): IMakaioSession {
      return {
        sessionId: ids.sessionId,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        agents: [],
        status: 'active',
        ...overrides,
      };
    },

    /**
     * Registers a mock session.get handler.
     * @param session - Session to return (or null)
     * @returns Unsubscribe function
     */
    registerSessionGetHandler(session: IMakaioSession | null): () => void {
      return MakaioBus.on(SessionSubjects.get, (context) => {
        context.setResult({ session });
      });
    },

    /**
     * Registers a mock adapter.startAgent handler that succeeds.
     * @param overrides - Optional response overrides
     * @returns Object with unsubscribe and received requests array
     */
    registerStartAgentHandler(overrides?: Partial<Extract<StartAgentResponse, { success: true }>>): {
      unsubscribe: () => void;
      receivedRequests: StartAgentRequestPayload[];
    } {
      const receivedRequests: StartAgentRequestPayload[] = [];
      const unsubscribe = MakaioBus.on(AdapterSubjects.startAgent, (context) => {
        receivedRequests.push(context.payload);
        context.setResult({
          success: true,
          agentId: ids.agentId,
          adapterId: context.payload.adapterId,
          adapterSessionId: ids.adapterSessionId,
          sessionId: ids.sessionId,
          messageId: ids.messageId,
          ...overrides,
        });
      });
      return { unsubscribe, receivedRequests };
    },

    /**
     * Registers a mock adapter.startAgent handler that fails.
     * @param errorMessage - Error message to return
     * @returns Unsubscribe function
     */
    registerFailingStartAgentHandler(errorMessage: string): () => void {
      return MakaioBus.on(AdapterSubjects.startAgent, (context) => {
        context.setResult({ success: false, message: errorMessage });
      });
    },

    registerKnownAdapter(adapterName: string, adapterId?: string): Promise<void> {
      return adapterIdentityRegistry.registerKnownAdapter(adapterName, adapterId);
    },

    /**
     * Registers the attach handler under test with the current turn manager.
     * @param machineId - Optional machine ID for scoped resolution
     * @returns Unsubscribe function
     */
    registerHandler(machineId?: string): () => void {
      return registerAttachHandler(MakaioBus, turnManager, machineId);
    },

    /**
     * Tears down all registered handlers and turn lifecycle state.
     */
    destroy(): void {
      for (const unsub of unsubscribers) {
        unsub();
      }
      unsubscribers.length = 0;
      nextTurnNumberBySession.clear();
      defaultAdapterCapabilities = ['session:resume'];
      turnManager.destroy();
    },
  };
}

/** Test context for attach handler tests. */
export interface AttachHandlerTestContext {
  turnManager: SessionTurnManager;
  getActiveTurn: (sessionId: string) => Turn | undefined;
  trackUnsubscribe: (unsub: () => void) => void;
  setDefaultAdapterCapabilities: (capabilities: string[]) => void;
  createMockSession: (overrides?: Partial<IMakaioSession>) => IMakaioSession;
  registerSessionGetHandler: (session: IMakaioSession | null) => () => void;
  registerStartAgentHandler: (overrides?: Partial<Extract<StartAgentResponse, { success: true }>>) => {
    unsubscribe: () => void;
    receivedRequests: StartAgentRequestPayload[];
  };
  registerFailingStartAgentHandler: (errorMessage: string) => () => void;
  registerKnownAdapter: (adapterName: string, adapterId?: string) => Promise<void>;
  registerHandler: (machineId?: string) => () => void;
  destroy: () => void;
}

// =============================================================================
// Fork Handler Test Context
// =============================================================================

/**
 * Creates a test context for fork handler tests.
 * Encapsulates the repeated setup: resetBusHandlers, registerForkHandler, cleanups,
 * and common mock registrations for session.get, session.create, branch.created.
 * @returns Context with cleanup tracking and common mock setup helpers
 */
export function createForkHandlerContext(): ForkHandlerTestContext {
  resetBusHandlers();
  const cleanup = registerForkHandler(MakaioBus);
  const cleanups: Array<() => void> = [cleanup];

  return {
    /**
     * Adds a cleanup function to be called on destroy.
     * @param fn - Cleanup function
     */
    addCleanup(fn: () => void): void {
      cleanups.push(fn);
    },

    /**
     * Registers a mock MessageStorageSubjects.get handler for fork point validation.
     * @param sourceSessionId - Session ID for the returned message
     */
    registerMessageGetMock(sourceSessionId = 'source-session'): void {
      cleanups.push(
        MakaioBus.on(MessageStorageSubjects.get, (busCtx) => {
          busCtx.setResult({
            message: {
              messageId: busCtx.payload.messageId,
              // Provider-native ID so mid-history fork points resolve instead
              // of degrading with 'fork-point-unresolvable'.
              adapterMessageId: `adapter-${String(busCtx.payload.messageId)}`,
              turnId: null,
              sessionId: sourceSessionId,
              role: 'user',
              contentText: 'test',
              blocks: [],
              timestamp: Date.now(),
            },
          });
        }),
      );
    },

    /**
     * Registers the standard trio of fork mocks: session.get, session.create, branch.created.
     * @param options - Optional overrides for source session ID, fork result, and create payload capture
     */
    setupForkMocks(options?: {
      sourceSessionId?: string;
      forkResultSessionId?: string;
      onCreatePayload?: (payload: SessionCreateRequestPayload) => void;
    }): void {
      const sourceSessionId = options?.sourceSessionId ?? 'source-session';
      const resultSessionId = options?.forkResultSessionId ?? 'new-fork-session';
      const onCreatePayload = options?.onCreatePayload;

      cleanups.push(
        MakaioBus.on(SessionSubjects.get, (ctx) => {
          ctx.setResult({
            session: {
              sessionId: sourceSessionId,
              title: 'Source',
              createdAt: Date.now(),
              lastActivityAt: Date.now(),
              status: 'active',
              agents: [],
            },
          });
        }),
      );

      cleanups.push(
        MakaioBus.on(SessionSubjects.create, (ctx) => {
          onCreatePayload?.(ctx.payload);
          ctx.setResult({ sessionId: resultSessionId });
        }),
      );

      cleanups.push(MakaioBus.on(SessionSubjects.branch.created, () => {}));
    },

    /**
     * Tears down all registered handlers.
     */
    destroy(): void {
      for (const cleanup of cleanups) {
        cleanup();
      }
      cleanups.length = 0;
    },
  };
}

/** Test context for fork handler tests. */
export interface ForkHandlerTestContext {
  addCleanup: (fn: () => void) => void;
  setupForkMocks: (options?: {
    sourceSessionId?: string;
    forkResultSessionId?: string;
    onCreatePayload?: (payload: SessionCreateRequestPayload) => void;
  }) => void;
  /**
   * Registers a mock MessageStorageSubjects.get handler for fork point validation.
   * @param sourceSessionId - Session ID for the returned message
   */
  registerMessageGetMock: (sourceSessionId?: string) => void;
  destroy: () => void;
}
