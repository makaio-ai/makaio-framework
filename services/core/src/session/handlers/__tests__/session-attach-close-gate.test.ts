import { afterEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { SessionSubjects } from '@makaio/contracts';
import { SessionAttachCloseGate } from '../session-attach-close-gate.js';

describe('SessionAttachCloseGate', () => {
  afterEach(() => MakaioBus.__resetHandlers?.());

  it('retains the close claim until every concurrent close request finishes', async () => {
    const gate = new SessionAttachCloseGate();
    const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()] as const;
    const releases = [Promise.withResolvers<void>(), Promise.withResolvers<void>()] as const;
    let requestIndex = 0;
    const cleanupMiddleware = gate.registerCloseMiddleware(MakaioBus);
    const cleanupHandler = MakaioBus.on(SessionSubjects.close, async (context) => {
      const index = requestIndex++;
      entered[index]?.resolve();
      await releases[index]?.promise;
      context.setResult({ success: true });
    });

    const firstClose = MakaioBus.request(SessionSubjects.close, { sessionId: 'session-1' });
    const secondClose = MakaioBus.request(SessionSubjects.close, { sessionId: 'session-1' });
    await Promise.all(entered.map(({ promise }) => promise));

    releases[0].resolve();
    await firstClose;
    expect(() => gate.assertAttachCommitAllowed('session-1')).toThrow('Session close won');

    releases[1].resolve();
    await secondClose;
    expect(() => gate.assertAttachCommitAllowed('session-1')).not.toThrow();

    cleanupHandler();
    cleanupMiddleware();
  });
});
