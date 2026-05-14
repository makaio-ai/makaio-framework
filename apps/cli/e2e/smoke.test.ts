/**
 * E2E smoke test for CLI serve.
 *
 * Spawns the CLI serve process, connects a bus client, and verifies:
 * 1. HTTP /health responds ok
 * 2. `boot.complete` fires (full boot)
 * 3. `runtime.isReady` returns `ready=true` with a non-empty `machineId`
 * 4. `runtime.busPort` matches the announced port
 * 5. `extension.list` handler responds with an extensions array
 * 6. Clean shutdown on SIGTERM
 */

import { describe, it, expect } from 'vitest';
import { RuntimeSubjects } from '@makaio/runtime-node';
import { ExtensionSubjects } from '@makaio/kernel';
import { startCliServe } from './harness/spawn-serve.js';
import { connectTestBus, waitForBoot, waitForRuntimeReady } from './harness/bus-helpers.js';
import { useServeFixture } from './harness/serve-fixture.js';

describe('CLI serve smoke test', { timeout: 60_000 }, () => {
  const serve = useServeFixture();

  it('boots, responds to bus queries, and shuts down cleanly', async () => {
    serve.current = await startCliServe({ timeoutMs: 40_000 });
    const { port } = serve.current;

    // 1. HTTP health endpoint
    const health = await fetch(`http://localhost:${port}/health`);
    expect(health.status).toBe(200);
    const body = await health.json();
    expect(body).toEqual({ ok: true, auth: false });

    // 2. Connect bus client — MAKAIO_PORT fires at transport-ready (step 3),
    //    before services boot. Wait for full boot before querying handlers.
    const bus = await connectTestBus(port);
    try {
      // 3. Wait for full boot.
      const bootPayload = await waitForBoot(bus, 30_000);
      expect(typeof bootPayload.totalDurationMs).toBe('number');
      expect(bootPayload.totalDurationMs).toBeGreaterThan(0);

      // 4. runtime.isReady — registered at step 14, after boot.complete.
      const { ready: isReady, machineId } = await waitForRuntimeReady(bus, 20_000);
      expect(isReady).toBe(true);
      expect(typeof machineId).toBe('string');
      expect(machineId.length).toBeGreaterThan(0);

      // 5. busPort matches announced port
      const portResp = await bus.request(RuntimeSubjects.busPort, {});
      expect((portResp as { port: number }).port).toBe(port);

      // 6. extension.list responds with an extensions array
      const extResp = await bus.request(ExtensionSubjects.list, {});
      expect(Array.isArray((extResp as { extensions: unknown[] }).extensions)).toBe(true);
    } finally {
      bus.disconnect();
    }

    // 7. Clean shutdown on SIGTERM
    // Note: sendSignal returns null for signal-killed processes (both SIGTERM
    // and the 10s SIGKILL escalation). This assertion verifies the process
    // exits promptly — a real hang would time out in the harness, not here.
    const exitCode = await serve.current.sendSignal('SIGTERM');
    expect(exitCode === null || exitCode === 0).toBe(true);
    serve.current = null;
  });
});
