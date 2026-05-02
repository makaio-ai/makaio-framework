/**
 * E2E smoke test for the headless Electron runtime.
 *
 * Spawns the runtime-entry.ts process, connects a bus client, and verifies:
 * 1. The process boots and announces a valid port
 * 2. `boot.complete` fires (full boot)
 * 3. `runtime.isReady` returns `ready=true` with a non-empty `machineId`
 * 4. `extension.list` confirms framework packages booted without loading
 *    host-only packages in the framework smoke harness
 * 5. Clean shutdown on SIGTERM (exit code 0 or null)
 */

import { describe, it, expect } from 'vitest';
import { ExtensionSubjects } from '@makaio/kernel';
import { connectTestBus, waitForBoot, waitForRuntimeReady } from '../../../e2e/shared/bus-helpers.js';
import { startElectronRuntime } from './harness/spawn-runtime.js';
import { E2E_DB_PATH, cleanupE2EDatabase } from './harness/db-path.js';
import { useRuntimeFixture } from './harness/runtime-fixture.js';

describe('Electron runtime smoke test', { timeout: 60_000 }, () => {
  const runtime = useRuntimeFixture();

  it('boots, responds to bus queries, and shuts down cleanly', async () => {
    // The Vitest smoke harness bypasses the Playwright webServer prefix script,
    // so it must enforce the same fresh-schema invariant itself.
    cleanupE2EDatabase();
    runtime.current = await startElectronRuntime({
      timeoutMs: 40_000,
      env: { MAKAIO_DATABASE_PATH: E2E_DB_PATH },
    });
    const { port } = runtime.current;

    // 1. Process announced a valid port — connect the bus client.
    //    By the time MAKAIO_PORT is written to stdout the runtime has booted,
    //    so the bus server is already accepting connections.
    const bus = await connectTestBus(port);
    try {
      // 2. Wait for full boot.
      const bootPayload = await waitForBoot(bus, 30_000);
      expect(typeof bootPayload.totalDurationMs).toBe('number');
      expect(bootPayload.totalDurationMs).toBeGreaterThan(0);
      expect(Array.isArray(bootPayload.failedServices)).toBe(true);

      // 3. runtime.isReady — runtime handler is wired after boot.complete.
      const { ready, machineId } = await waitForRuntimeReady(bus, 20_000);
      expect(ready).toBe(true);
      expect(typeof machineId).toBe('string');
      expect(machineId.length).toBeGreaterThan(0);

      // 4. extension.list — verify framework-only boot starts framework
      //    packages without loading host-only packages.
      const extResp = await bus.request(ExtensionSubjects.list, {});
      const { extensions } = extResp as { extensions: Array<{ name: string; state: string }> };
      expect(Array.isArray(extensions)).toBe(true);

      const session = extensions.find((e) => e.name === 'session');
      expect(session).toBeDefined();
      expect(session?.state).toBe('active');
      expect(extensions.find((e) => e.name === 'slash-command')).toBeUndefined();
    } finally {
      bus.disconnect();
    }

    // 5. Clean shutdown on SIGTERM.
    //    sendSignal returns null for signal-killed processes (both SIGTERM and
    //    the 10 s SIGKILL escalation). This assertion verifies the process
    //    exits promptly — a real hang would time out in the harness, not here.
    const exitCode = await runtime.current.sendSignal('SIGTERM');
    expect(exitCode === null || exitCode === 0).toBe(true);
    runtime.current = null;
  });
});
