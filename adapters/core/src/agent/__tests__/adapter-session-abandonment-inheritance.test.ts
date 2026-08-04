/**
 * What a connector generation inherits after the agent abandoned its resume target.
 *
 * The escalation path this covers: a dispatch that declines native resume
 * abandons the armed target and announces the movement as unconfirmed, the turn
 * then ends without the provider confirming a successor, and a later
 * cwd/model/MCP swap omits an explicit resume decision. That swap falls back
 * through `buildConfigFactoryInput` to the agent-level resume target, so the
 * replacement connector must not be handed the provider session the movement
 * just marked abandoned — the session row already stopped advertising it.
 *
 * Both halves of the policy/datum split are covered, because dropping the target
 * is only half the invariant: an agent that inherits resume targets must resume
 * the *successor* once the provider names one, and an agent born without a target
 * must still never acquire one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects, type AdapterSessionMoved } from '@makaio/contracts';
import type { ConfigFactoryInput } from '../../adapter/index.js';
import { MockConnector, createTestableAgent, type TestableAgent } from './helpers/mock-agent.js';

vi.mock('@makaio/hooks', () => ({
  runPreUserMessageHooks: vi.fn(async (payload: { message: unknown; sessionContext?: unknown }) => ({
    message: payload.message,
    sessionContext: payload.sessionContext,
  })),
  runPostUserMessageHooks: vi.fn(async () => {}),
}));

const ABANDONED_TARGET = 'abandoned-provider-thread';
const SUCCESSOR_THREAD = 'successor-provider-thread';

/**
 * Connector double for a generation seeded with an unconsumed resume target.
 *
 * Reports the seeded target as its session ID while admitting that declining
 * native resume would rotate away from it — the state a Claude resume agent is
 * in before `system.init`, and the one `providerCommittedAdapterSessionId`
 * withholds the ID for.
 */
class UnconfirmedResumeConnector extends MockConnector {
  /** Whether this generation still holds an unconsumed resume target. */
  public rotationPending = true;

  /** Session the provider committed to after the rotation, once it does. */
  public confirmedSuccessor: string | undefined;

  /** @returns Seeded resume target while unconfirmed, the committed successor afterwards */
  public getConfirmedAdapterSessionId(): string | undefined {
    return this.rotationPending ? ABANDONED_TARGET : this.confirmedSuccessor;
  }

  /** @returns Whether declining native resume would rotate the provider session */
  public movesProviderSessionOnSuppressedResume(): boolean {
    return this.rotationPending;
  }
}

describe('resume-target inheritance after an abandoned provider session', () => {
  let agent: TestableAgent | undefined;
  let connectors: UnconfirmedResumeConnector[];
  let configInputs: ConfigFactoryInput[];
  let movements: AdapterSessionMoved[];
  let unsubscribe: () => void;

  beforeEach(() => {
    connectors = [];
    configInputs = [];
    movements = [];
    unsubscribe = MakaioBus.on(AgentSubjects.adapterSession.moved, ({ payload }) => {
      movements.push(payload);
    });
    agent = createTestableAgent({
      agentId: 'agent-abandonment',
      sessionId: 'session-abandonment',
      resumeAdapterSessionId: ABANDONED_TARGET,
      onConfigFactoryInput: (input) => configInputs.push(input),
      mockConnectorFactory: ({ model, cwd }) => {
        const connector = new UnconfirmedResumeConnector(model, cwd);
        connectors.push(connector);
        return connector;
      },
    });
  });

  afterEach(async () => {
    unsubscribe();
    await agent?.close();
    agent = undefined;
  });

  it('does not hand the abandoned provider session to a swap without a resume decision', async () => {
    await agent!.init();
    // The test agent does not support native resume, so this dispatch declines
    // it and abandons the armed target. No `system.init` follows: the generation
    // keeps reporting a pending rotation, exactly like a turn that failed or
    // idled before the provider confirmed a successor.
    await agent!.start('hello');

    expect(movements.filter((movement) => movement.confirmed === false)).toHaveLength(1);

    // A cwd swap carries no resume decision, so it inherits whatever the agent
    // config still advertises.
    await agent!.swapConnector({ cwd: '/swapped/cwd' });

    expect(connectors).toHaveLength(2);
    expect(configInputs[configInputs.length - 1]?.resumeAdapterSessionId).toBeUndefined();
  });

  it('inherits the confirmed successor once the provider commits to one', async () => {
    // Why dropping the abandoned target must not disable inheritance outright:
    // this agent *does* inherit resume targets, so the moment the provider names
    // a successor, later swaps have to continue that thread. Clearing the field
    // as the whole fix would have left this agent on fresh-swap semantics
    // permanently — and no existing test would have noticed.
    await agent!.init();
    await agent!.start('hello');

    // `system.init` arrives late: the generation stops reporting a pending
    // rotation and names the session the provider actually committed to.
    connectors[0].rotationPending = false;
    connectors[0].confirmedSuccessor = SUCCESSOR_THREAD;
    // Payload enrichment on the agent's next event is what samples it.
    await agent!.testEmitStart();

    expect(movements[movements.length - 1]).toMatchObject({
      adapterSessionId: SUCCESSOR_THREAD,
      confirmed: true,
    });

    await agent!.swapConnector({ cwd: '/swapped/cwd' });

    expect(configInputs[configInputs.length - 1]?.resumeAdapterSessionId).toBe(SUCCESSOR_THREAD);
  });

  it('still inherits the start-time target for a swap before any dispatch abandoned it', async () => {
    // Counter-check that keeps the fix honest: an idle attach whose armed target
    // is untouched must keep resuming it across a swap.
    await agent!.init();
    await agent!.swapConnector({ cwd: '/swapped/cwd' });

    expect(movements.filter((movement) => movement.confirmed === false)).toHaveLength(0);
    expect(configInputs[configInputs.length - 1]?.resumeAdapterSessionId).toBe(ABANDONED_TARGET);
  });
});
