import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import { WebSocketClientTransport } from '@makaio/bus-transport-websocket';
import { FrameworkContractNamespaces } from '@makaio/contracts';
import { closeHttpServer, listenOnLoopback } from '../../__tests__/http-test-helpers.js';
import { BusServerTransportProvider } from '../../bus-server-transport.js';
import { runHeadlessWorkflowWorker, type HeadlessWorkflowWorkerDeps } from '../headless-workflow-worker.js';
import { createAttemptAuthorityHarness } from './attempt-authority-harness.js';

/** Startup input rejection must precede executable acquisition and runtime composition. */
async function unreachable(): Promise<never> {
  throw new Error('Malformed workflow input reached executable runtime dependencies');
}

describe('malformed opaque workflow input', () => {
  it('reports actual adapter startup rejection and receives the committed technical failure acknowledgement', async () => {
    const executionId = 'malformed-workflow-owner';
    const bus = createBusInstance();
    bus.registerNamespaces(FrameworkContractNamespaces);
    const attempt = await createAttemptAuthorityHarness(bus, executionId, {
      instruction: {
        id: 'malformed-instruction',
        revision: '1',
        workload: { kind: 'workflow', version: '1', input: {} },
        preservation: { required: [] },
      },
    });
    const server = createServer();
    const port = await listenOnLoopback(server);
    const transport = new BusServerTransportProvider({ httpServer: server, auth: attempt.serverAuth });
    try {
      await transport.connect(bus, 'malformed-input-authority');
      const deps: HeadlessWorkflowWorkerDeps = {
        executionId,
        executionAttemptId: attempt.executionAttemptId,
        bootstrapDeadlineAt: attempt.bootstrapDeadlineAt,
        workflowEnv: {},
        bootstrap: async () => ({ busUrl: `ws://127.0.0.1:${port}/bus`, busAuthSecret: 'fixture-only' }),
        connectBus: async (workerBus, credentials) => {
          workerBus.registerTransport(
            new WebSocketClientTransport({
              url: credentials.busUrl,
              autoReconnect: false,
              auth: attempt.createClientAuth(),
            }),
          );
          await workerBus.connect();
        },
        materialize: unreachable,
        loadContributions: unreachable,
        execute: unreachable,
        configRepository: {
          loadAdapterConfigs: unreachable,
          loadProviderConfigs: unreachable,
          writeProviderConfig: unreachable,
          deleteProviderConfig: unreachable,
          writeAdapterFile: unreachable,
          deleteAdapterFile: unreachable,
        },
        toolsets: [],
        outcomeRetry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, deadlineMs: 1_000 },
      };
      const pendingOutcome = attempt.authority.waitForOutcome(attempt.executionAttemptId);
      expect(pendingOutcome).toBeDefined();
      const result = await runHeadlessWorkflowWorker(deps, new AbortController().signal);
      expect(result).toMatchObject({ decision: 'accepted', outcome: { kind: 'technical-failure', stage: 'startup' } });
      if (result.outcome.kind !== 'technical-failure') {
        throw new Error('Expected the actual adapter startup rejection');
      }
      expect(result.outcome.message).toContain('executionId');
      expect(result.outcome.message).not.toContain('Malformed workflow input reached');
      expect(attempt.convergedOutcomes).toEqual([result.outcome]);
      await expect(pendingOutcome).resolves.toEqual(result.outcome);
      await expect(attempt.authority.getAttemptWithAllocation(attempt.executionAttemptId)).resolves.toMatchObject({
        status: 'settled',
        operationStartGate: 'closed',
        claimable: false,
      });
      expect(attempt.runtimeReadyEvents).toHaveLength(1);
      expect(attempt.operationAdmittedEvents).toHaveLength(0);
    } finally {
      await transport.disconnect();
      await closeHttpServer(server);
      await attempt.cleanup();
    }
  });
});
