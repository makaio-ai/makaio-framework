import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects, type Party } from '@makaio/contracts';
import { createTestCall } from '@makaio/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { MessageHandle } from '../../message-handle/index.js';
import { ConfirmedAdapterSessionTracker } from '../agent-adapter-session-movement.js';
import { createAgentEmissionWiring, createOnMessageSentEmitter } from '../agent-emission-wiring.js';
import { MessageLifecycleTracker } from '../message-lifecycle-tracker.js';

const PERSON_A = { kind: 'acme.user', id: 'person-a' } satisfies Party;
const PERSON_B = { kind: 'acme.user', id: 'person-b' } satisfies Party;

/**
 * Create the production emitter and trackers on the real global bus.
 * @param adapterSessionId - Provider-confirmed identity available to enrichment
 * @returns Emitter for the test agent
 */
function createEmitter(adapterSessionId?: string) {
  const host = {
    agentId: 'emission-agent',
    adapterId: 'test-adapter',
    adapterName: 'test',
    machineId: 'test-machine',
    ownerInstanceId: 'test-owner',
  };
  const emitter = createAgentEmissionWiring({
    globalBus: MakaioBus,
    host,
    lifecycleTracker: new MessageLifecycleTracker({
      emitGlobal: (...args): Promise<void> => emitter.emitGlobal(...args),
    }),
    adapterSessionTracker: new ConfirmedAdapterSessionTracker(MakaioBus, host),
    getConnector: () => ({
      getConfirmedAdapterSessionId: () => adapterSessionId,
      movesProviderSessionOnSuppressedResume: () => false,
    }),
  });
  return emitter;
}

describe('agent emission wiring', () => {
  it('publishes the submitted message under the principal on its handle', async () => {
    const emitter = createEmitter();
    const onMessageSent = createOnMessageSentEmitter(emitter.emitGlobal.bind(emitter));
    const call = createTestCall({ principal: PERSON_A });
    const handle = new MessageHandle(
      call,
      'submitted-message',
      { role: 'user', message: 'hello', blocks: [{ type: 'text', content: 'hello' }] },
      'enqueue',
    );
    const principals: Party[] = [];
    const unsubscribe = MakaioBus.on(AgentSubjects.user_message.sent, (ctx) => {
      if (ctx.payload.messageId === handle.messageId) principals.push(ctx.call.principal);
    });

    try {
      onMessageSent(handle);
      await vi.waitFor(() => expect(principals).toHaveLength(1));
      expect(principals).toEqual([PERSON_A]);
    } finally {
      unsubscribe();
    }
  });

  it('announces a newly observed provider session under the enriched emission principal', async () => {
    const emitter = createEmitter('confirmed-provider-session');
    const call = createTestCall({ principal: PERSON_B });
    const movements: Array<{ adapterSessionId?: string; principal: Party }> = [];
    const unsubscribe = MakaioBus.on(AgentSubjects.adapterSession.moved, (ctx) => {
      movements.push({ adapterSessionId: ctx.payload.adapterSessionId, principal: ctx.call.principal });
    });

    try {
      await emitter.emitGlobal(call, AgentSubjects.message, { content: 'hello' });
      expect(movements).toEqual([{ adapterSessionId: 'confirmed-provider-session', principal: PERSON_B }]);
    } finally {
      unsubscribe();
    }
  });
});
