/**
 * The composition Path D's cases run against.
 *
 * Real memory agent and ownership storage over one state and the real authority,
 * so the claim rows, the designation and the agent row the cases assert are the
 * durable effects of the seam under test. The only stand-in is the adapter,
 * which is another process's concern.
 *
 * Extracted because two suites drive the same attach — one for what it takes
 * before dispatching, one for what it unwinds after — and a second copy of the
 * seeding is a second chance for them to disagree about what "the same attach"
 * means.
 */
import { MakaioBus } from '@makaio/bus-core';
import type { ExtractSubjectResponse } from '@makaio/core';
import { AdapterSubjects, SessionSubjects, type IMakaioSession, type StartAgentResponse } from '@makaio/contracts';
import { buildDeterministicAdapterId } from '../../../adapter-runtime/index.js';
import { registerSessionOwnershipAuthority } from '../../ownership/authority.js';
import { AgentStorageSubjects } from '../../storage/agent-namespace.js';
import { ATTACH_TEST_IDS, createAttachHandlerContext, type AttachHandlerTestContext } from './shared.js';
import type { StartAgentRequestPayload } from './shared.js';

/** Machine the attach handler and the reservations act under. */
export const MACHINE = 'local-machine';
/** Provider session the session's native resume target names. */
export const PROVIDER = 'provider-session-native';
/** Adapter instance every attach in these suites is addressed to. */
export const ADAPTER_ID = buildDeterministicAdapterId(MACHINE, ATTACH_TEST_IDS.adapterName);
/**
 * Run a fault or a recorder ahead of the backend it shadows.
 *
 * The memory backends answer first otherwise, so an injector has to say so.
 */
export const FIRST = { priority: 1000 } as const;

/** Everything a Path-D case drives and observes. */
export interface ReservedAttachContext {
  /** The attach handler's own composition, for whatever a case registers itself. */
  readonly ctx: AttachHandlerTestContext;
  /** Every `adapter.startAgent` the stand-in observed, in order. */
  readonly dispatched: StartAgentRequestPayload[];
  /** Claims the agent held at the instant its start was dispatched. */
  readonly claimsAtDispatch: number[];
  /**
   * Every agent `adapter.stopAgent` was asked to stop, in order.
   *
   * Recorded here rather than per case, so a case that must prove the connector
   * was **not** stopped asserts against a recorder that provably ran — a locally
   * registered one would be shadowed by this composition and pass vacuously.
   */
  readonly stopped: string[];
  /** Every owner-targeted stop request the composition observed. */
  readonly stoppedTargets: Array<{
    readonly agentId: string;
    readonly ownerInstanceId: string | undefined;
    readonly teardown: 'connector-only' | undefined;
  }>;
  /**
   * Seed the session a native resume attach runs against.
   * @param overrides - Fields to place on the session row.
   */
  seedSession: (overrides?: Partial<IMakaioSession>) => IMakaioSession;
  /**
   * Answer `adapter.startAgent` as an adapter does, recording every payload.
   * @param respond - What the adapter answers, and any side effect it runs first.
   */
  registerAdapter: (
    respond?: (
      payload: StartAgentRequestPayload,
    ) => Promise<StartAgentResponse | undefined> | StartAgentResponse | undefined,
    options?: { readonly omitResponseOwnerInstanceId?: boolean },
  ) => void;
  /**
   * Issue the attach under test.
   * @param overrides - Payload fields beyond the session and adapter selection.
   */
  attach: (overrides?: Record<string, unknown>) => Promise<{ agentId: string }>;
  /**
   * Probe whether a key is free, by actually trying to reserve it.
   * @param providerSessionId - Key to contest.
   */
  tryClaim: (
    providerSessionId: string,
  ) => Promise<ExtractSubjectResponse<typeof SessionSubjects.ownership.reserveStart>>;
  /** Tear the composition down. */
  destroy: () => void;
}

/**
 * Compose the backends, the authority and the stop recorder for one case.
 * @returns The context the case drives and observes.
 */
export function createReservedAttachContext(): ReservedAttachContext {
  const { sessionId, adapterName } = ATTACH_TEST_IDS;
  const ctx = createAttachHandlerContext();
  const dispatched: StartAgentRequestPayload[] = [];
  const claimsAtDispatch: number[] = [];
  const stopped: string[] = [];
  const stoppedTargets: Array<{
    readonly agentId: string;
    readonly ownerInstanceId: string | undefined;
    readonly teardown: 'connector-only' | undefined;
  }> = [];
  let attachHandlerRegistered = false;
  void MakaioBus.emit(AdapterSubjects.initialized, {
    adapterId: ADAPTER_ID,
    adapterName,
    machineId: MACHINE,
    ownerInstanceId: ATTACH_TEST_IDS.ownerInstanceId,
    capabilities: [],
  });
  const authority = registerSessionOwnershipAuthority({
    bus: MakaioBus,
    machineId: MACHINE,
    instanceId: ATTACH_TEST_IDS.ownerInstanceId,
    topology: 'shared-machine',
  });
  for (const cleanup of authority.cleanups) ctx.trackUnsubscribe(cleanup);
  ctx.trackUnsubscribe(
    MakaioBus.on(AdapterSubjects.stopAgent, (context) => {
      stopped.push(context.payload.agentId);
      stoppedTargets.push({
        agentId: context.payload.agentId,
        ownerInstanceId: context.payload.ownerInstanceId,
        teardown: context.payload.teardown,
      });
      // "Succeeded" is never evidence a connector closed (I15); the cases that
      // care assert that they did not treat it as such.
      context.setResult({ success: true, evidence: 'released' });
    }),
  );

  return {
    ctx,
    dispatched,
    claimsAtDispatch,
    stopped,
    stoppedTargets,
    seedSession: (overrides) => {
      const session = ctx.createMockSession({
        machineId: MACHINE,
        adapterName,
        adapterSessionId: PROVIDER,
        ...overrides,
      });
      ctx.trackUnsubscribe(ctx.registerSessionGetHandler(session));
      return session;
    },
    registerAdapter: (respond, options) => {
      ctx.trackUnsubscribe(
        MakaioBus.on(AdapterSubjects.startAgent, async (context) => {
          const payload = context.payload;
          dispatched.push(payload);
          if (payload.agentId === undefined) {
            // Every Path-D dispatch is caller-owned in this wave; a silent '' probe
            // here would record 0 claims and let a reservation-first violation pass.
            throw new Error('[reserved-attach-fixture] adapter.startAgent dispatched without a caller-owned agentId');
          }
          claimsAtDispatch.push(ctx.getAgentClaims(payload.agentId).length);
          const answer = await respond?.(payload);
          if (answer !== undefined) {
            context.setResult(
              (answer.success
                ? (() => {
                    if (options?.omitResponseOwnerInstanceId) {
                      const { ownerInstanceId: _responseOwnerInstanceId, ...answerWithoutOwner } = answer;
                      return answerWithoutOwner;
                    }
                    return {
                      ...answer,
                      ownerInstanceId: answer.ownerInstanceId ?? payload.ownerInstanceId ?? 'reserved-attach-owner',
                      settlementAckToken: answer.settlementAckToken ?? `ack-${payload.agentId}`,
                    };
                  })()
                : answer) as never,
            );
            return;
          }
          // The connector lands on the key it was asked to resume, or on one of
          // its own for a fresh start — which is what makes a degraded attach
          // observably different from a native one in the claim table.
          context.setResult({
            success: true,
            agentId: payload.agentId,
            adapterId: payload.adapterId,
            adapterSessionId: payload.mode === 'resume' ? payload.adapterSessionId : `fresh-${dispatched.length}`,
            sessionId,
            messageId: 'msg-001',
            ownerInstanceId: payload.ownerInstanceId ?? 'reserved-attach-owner',
            settlementAckToken: `ack-${payload.agentId}`,
          });
        }),
      );
    },
    attach: async (overrides) => {
      // A second registration would leave two identical handlers racing on bus
      // resolution order; a case that attaches twice reuses the first.
      if (!attachHandlerRegistered) {
        ctx.trackUnsubscribe(ctx.registerHandler(MACHINE));
        attachHandlerRegistered = true;
      }
      return MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName },
        ...overrides,
      });
    },
    tryClaim: async (providerSessionId) => {
      const agentId = `probe-${crypto.randomUUID()}`;
      const now = Date.now();
      await MakaioBus.request(AgentStorageSubjects.set, {
        agentId,
        agent: {
          agentId,
          adapterId: ADAPTER_ID,
          adapterName,
          sessionId,
          role: 'member',
          status: 'idle',
          createdAt: now,
          lastActivityAt: now,
        },
      });
      return MakaioBus.request(SessionSubjects.ownership.reserveStart, {
        sessionId,
        agentId,
        adapterId: ADAPTER_ID,
        adapterName,
        role: 'member',
        ownerInstanceId: ATTACH_TEST_IDS.ownerInstanceId,
        resumeProviderSessionId: providerSessionId,
        claimToken: crypto.randomUUID(),
        machineId: MACHINE,
      });
    },
    destroy: () => ctx.destroy(),
  };
}
