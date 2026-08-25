import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ATTACH_TEST_IDS } from './shared.js';
import { createReservedAttachContext, PROVIDER, type ReservedAttachContext } from './reserved-attach-fixture.js';

describe('reserved attach missing owner cleanup', () => {
  let fixture: ReservedAttachContext;

  beforeEach(() => {
    fixture = createReservedAttachContext();
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('retires and stops a dispatched start that omits its runtime owner', async () => {
    const { sessionId } = ATTACH_TEST_IDS;
    fixture.seedSession();
    fixture.registerAdapter(
      (payload) => ({
        success: true,
        agentId: payload.agentId!,
        adapterId: payload.adapterId,
        adapterSessionId: PROVIDER,
        sessionId,
        messageId: 'msg-missing-owner',
        ownerInstanceId: ATTACH_TEST_IDS.ownerInstanceId,
        settlementAckToken: `ack-${payload.agentId}`,
      }),
      { omitResponseOwnerInstanceId: true },
    );

    await expect(fixture.attach({ role: 'member' })).rejects.toThrow('adapter omitted its owner instance');
    expect(fixture.stoppedTargets).toEqual([
      {
        agentId: fixture.dispatched[0]?.agentId ?? '',
        ownerInstanceId: ATTACH_TEST_IDS.ownerInstanceId,
        teardown: 'connector-only',
      },
    ]);
  });

  it('retires and stops a dispatch whose response was lost at the selected runtime', async () => {
    fixture.seedSession();
    fixture.registerAdapter(() => {
      throw new Error('response lost after start');
    });

    await expect(fixture.attach({ role: 'member' })).rejects.toThrow('response lost after start');
    expect(fixture.stoppedTargets).toEqual([
      {
        agentId: fixture.dispatched[0]?.agentId ?? '',
        ownerInstanceId: ATTACH_TEST_IDS.ownerInstanceId,
        teardown: 'connector-only',
      },
    ]);
  });

  it('retires and stops an uncertain dispatch result at the selected runtime', async () => {
    fixture.seedSession();
    fixture.registerAdapter(() => ({ success: false, dispatch: 'dispatch-uncertain', message: 'provider uncertain' }));

    await expect(fixture.attach({ role: 'member' })).rejects.toThrow('provider uncertain');
    expect(fixture.stoppedTargets).toEqual([
      {
        agentId: fixture.dispatched[0]?.agentId ?? '',
        ownerInstanceId: ATTACH_TEST_IDS.ownerInstanceId,
        teardown: 'connector-only',
      },
    ]);
  });

  it('stops the selected runtime when a response names a malicious owner', async () => {
    const { sessionId } = ATTACH_TEST_IDS;
    fixture.seedSession();
    fixture.registerAdapter((payload) => ({
      success: true,
      agentId: payload.agentId!,
      adapterId: payload.adapterId,
      adapterSessionId: PROVIDER,
      sessionId,
      messageId: 'msg-mismatched-owner',
      ownerInstanceId: 'malicious-owner-instance',
      settlementAckToken: `ack-${payload.agentId}`,
    }));

    await expect(fixture.attach({ role: 'member' })).rejects.toThrow('adapter owner mismatch');
    expect(fixture.stoppedTargets).toEqual([
      {
        agentId: fixture.dispatched[0]?.agentId ?? '',
        ownerInstanceId: ATTACH_TEST_IDS.ownerInstanceId,
        teardown: 'connector-only',
      },
    ]);
  });

  it.each([
    ['adapter', (payload: { readonly adapterId: string }) => ({ adapterId: `foreign-${payload.adapterId}` })],
    ['session', () => ({ sessionId: 'foreign-session' })],
  ])('stops the selected runtime when a response names a malicious %s', async (_field, mismatch) => {
    const { sessionId } = ATTACH_TEST_IDS;
    fixture.seedSession();
    fixture.registerAdapter((payload) => ({
      success: true,
      agentId: payload.agentId!,
      adapterId: payload.adapterId,
      adapterSessionId: PROVIDER,
      sessionId,
      messageId: 'msg-mismatched-identity',
      ownerInstanceId: ATTACH_TEST_IDS.ownerInstanceId,
      settlementAckToken: `ack-${payload.agentId}`,
      ...mismatch(payload),
    }));

    await expect(fixture.attach({ role: 'member' })).rejects.toThrow('adapter response identity mismatch');
    expect(fixture.stoppedTargets).toEqual([
      {
        agentId: fixture.dispatched[0]?.agentId ?? '',
        ownerInstanceId: ATTACH_TEST_IDS.ownerInstanceId,
        teardown: 'connector-only',
      },
    ]);
  });
});
