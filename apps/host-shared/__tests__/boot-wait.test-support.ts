import { createBusInstance, getFullSubjectForSubjectDefinition } from '@makaio/bus-core';
import { ServerTransport } from '@makaio/bus-transport-websocket';
import { BootNamespace, BootSubjects } from '@makaio/kernel';
import { vi } from 'vitest';
import { BootProgressObserver } from '../../../packages/kernel/src/extension/boot-progress-observer.js';
import { createBoundaryAccessCheck } from '../../../packages/kernel/src/rights/boundary-access.js';
import { createRightsHub } from '../../../packages/kernel/src/rights/rights-hub.js';
import { createTestServer } from '../../../transports/ws/src/__tests__/test-utils.js';

const completionSubject = getFullSubjectForSubjectDefinition(BootSubjects.complete);

/**
 * Start a boot host that admits startup observers through the kernel boundary.
 * @param cleanup - Registers teardown for this test.
 * @returns The real host observer, admission barrier, and wire observations.
 */
export async function startBootHost(cleanup: (fn: () => Promise<void>) => void) {
  const admissionStarted = Promise.withResolvers<void>();
  const admit = Promise.withResolvers<void>();
  const stateRequests = vi.fn();
  const stateProbeStarted = Promise.withResolvers<void>();
  const releaseStateProbe = Promise.withResolvers<void>();
  let stateProbeHeld = false;
  const { wss, port } = await createTestServer();
  const host = createBusInstance();
  host.registerNamespace(BootNamespace);
  const boot = new BootProgressObserver(host, 1);
  const checkAccess = createBoundaryAccessCheck(host, createRightsHub({ bus: host }), () => 'starting');
  const server = new ServerTransport({
    websocket: wss,
    checkBoundaryAccess: async (target, call, connection) => {
      if (target.operation === 'subscribe' && target.pattern === completionSubject) {
        admissionStarted.resolve();
        await admit.promise;
      }
      if (target.operation === 'send' && target.namespace === BootNamespace.name && target.subject === 'getState') {
        stateRequests();
        if (stateProbeHeld) {
          stateProbeStarted.resolve();
          await releaseStateProbe.promise;
        }
      }
      return checkAccess(target, call, connection);
    },
  });
  host.registerTransport(server);
  cleanup(async () => {
    vi.useRealTimers();
    admit.resolve();
    releaseStateProbe.resolve();
    boot.dispose();
    await server.disconnect();
  });
  await host.connect();
  const sends = vi.spyOn(server, 'send');
  return {
    url: `ws://127.0.0.1:${port}`,
    boot,
    admit,
    admissionStarted: admissionStarted.promise,
    sends,
    stateRequests,
    /**
     * Hold every later state probe at the boundary until teardown.
     * @returns Resolves when the first held probe reached the boundary.
     */
    holdStateProbe: (): Promise<void> => {
      stateProbeHeld = true;
      return stateProbeStarted.promise;
    },
  };
}
