import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, afterEach } from 'vitest';
import { createProcessLifecycle } from '../process-lifecycle.js';
import type { ProcessLifecycleHandle, ProcessState } from '../process-lifecycle.js';

/**
 * Helper: wait at most `ms` milliseconds for a condition to become true.
 * @param condition - Predicate to poll until it returns true.
 * @param ms - Maximum wait duration in milliseconds. Defaults to 2000.
 * @returns Promise that resolves when the condition is met.
 */
function waitFor(condition: () => boolean, ms: number = 2000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + ms;
    const tick = (): void => {
      if (condition()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`Condition not met within ${ms}ms`));
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe('createProcessLifecycle', () => {
  let handle: ProcessLifecycleHandle | undefined;

  afterEach(async () => {
    if (handle) {
      await handle.stop();
      handle = undefined;
    }
  });

  it('starts in idle state', () => {
    handle = createProcessLifecycle({
      spawn: { command: 'node', args: ['-e', ''], cwd: process.cwd() },
    });
    expect(handle.state).toBe('idle');
    expect(handle.transport).toBeUndefined();
  });

  it('resolves start() when first message is received from stdout', async () => {
    handle = createProcessLifecycle({
      spawn: {
        command: 'node',
        args: ['-e', 'process.stdout.write(\'{"ready":true}\\n\'); setTimeout(() => {}, 5000)'],
        cwd: process.cwd(),
        processName: 'test-ready',
      },
      healthTimeoutMs: 3000,
    });

    await handle.start();

    expect(handle.state).toBe('running');
    expect(handle.transport).toBeDefined();
  });

  it('transitions through idle → starting → running on successful start', async () => {
    const states: ProcessState[] = [];

    handle = createProcessLifecycle({
      spawn: {
        command: 'node',
        args: ['-e', 'process.stdout.write(\'{"ready":true}\\n\'); setTimeout(() => {}, 5000)'],
        cwd: process.cwd(),
      },
      onStateChange: (s) => states.push(s),
      healthTimeoutMs: 3000,
    });

    expect(handle.state).toBe('idle');
    await handle.start();

    expect(states).toEqual(['starting', 'running']);
    expect(handle.state).toBe('running');
  });

  it('stops the process gracefully and transitions to stopped', async () => {
    const states: ProcessState[] = [];

    handle = createProcessLifecycle({
      spawn: {
        command: 'node',
        args: ['-e', 'process.stdout.write(\'{"ready":true}\\n\'); setTimeout(() => {}, 60000)'],
        cwd: process.cwd(),
      },
      onStateChange: (s) => states.push(s),
      healthTimeoutMs: 3000,
      shutdownTimeoutMs: 2000,
    });

    await handle.start();
    await handle.stop();

    expect(handle.state).toBe('stopped');
    expect(states).toContain('stopping');
    expect(states).toContain('stopped');
    // Ensure stopped comes after stopping
    expect(states.indexOf('stopped')).toBeGreaterThan(states.indexOf('stopping'));
    handle = undefined; // already stopped — skip afterEach cleanup
  });

  it('follows the full idle → starting → running → stopping → stopped path', async () => {
    const states: ProcessState[] = [];

    handle = createProcessLifecycle({
      spawn: {
        command: 'node',
        args: ['-e', 'process.stdout.write(\'{"ready":true}\\n\'); setTimeout(() => {}, 60000)'],
        cwd: process.cwd(),
      },
      onStateChange: (s) => states.push(s),
      healthTimeoutMs: 3000,
    });

    expect(handle.state).toBe('idle');
    await handle.start();
    expect(handle.state).toBe('running');

    await handle.stop();
    expect(handle.state).toBe('stopped');

    expect(states).toEqual(['starting', 'running', 'stopping', 'stopped']);
    handle = undefined;
  });

  it('rejects start() on health timeout and sets state to crashed', async () => {
    handle = createProcessLifecycle({
      spawn: {
        command: 'node',
        args: ['-e', 'setTimeout(() => {}, 60000)'],
        cwd: process.cwd(),
        processName: 'test-timeout',
      },
      healthTimeoutMs: 500,
    });

    await expect(handle.start()).rejects.toThrow('health timeout');
    expect(handle.state).toBe('crashed');
    handle = undefined; // already cleaned up
  });

  it('sets state to crashed on non-zero exit while running', async () => {
    const states: ProcessState[] = [];

    handle = createProcessLifecycle({
      spawn: {
        command: 'node',
        args: ['-e', 'process.stdout.write(\'{"ready":true}\\n\'); setTimeout(() => process.exit(1), 100)'],
        cwd: process.cwd(),
      },
      onStateChange: (s) => states.push(s),
      healthTimeoutMs: 3000,
    });

    await handle.start();
    expect(handle.state).toBe('running');

    await waitFor(() => handle!.state === 'crashed', 2000);
    expect(handle.state).toBe('crashed');
    handle = undefined;
  });

  it('replaces the pre-ready exit listener with the running lifecycle listener after start', async () => {
    handle = createProcessLifecycle({
      spawn: {
        command: 'node',
        args: ['-e', 'process.stdout.write(\'{"ready":true}\\n\'); setTimeout(() => {}, 5000)'],
        cwd: process.cwd(),
      },
      healthTimeoutMs: 3000,
    });

    await handle.start();

    const exitListenerNames = handle.transport?.process.listeners('exit').map((listener) => listener.name);
    expect(exitListenerNames).toContain('handleRunningExit');
    expect(exitListenerNames).not.toContain('handleEarlyExit');
  });

  it('stop() cleans up and reaches stopped after the process has crashed', async () => {
    const states: ProcessState[] = [];

    handle = createProcessLifecycle({
      spawn: {
        command: 'node',
        args: ['-e', 'process.stdout.write(\'{"ready":true}\\n\'); setTimeout(() => process.exit(1), 50)'],
        cwd: process.cwd(),
      },
      onStateChange: (s) => states.push(s),
      healthTimeoutMs: 3000,
    });

    await handle.start();
    await waitFor(() => handle!.state === 'crashed', 2000);

    await expect(handle.stop()).resolves.toBeUndefined();

    expect(handle.state).toBe('stopped');
    expect(handle.transport).toBeUndefined();
    expect(states).toContain('crashed');
    expect(states.at(-1)).toBe('stopped');
    handle = undefined;
  });

  it('calls onExit with the exit code', async () => {
    let receivedCode: number | null | undefined;
    let exitCount = 0;

    handle = createProcessLifecycle({
      spawn: {
        command: 'node',
        args: ['-e', 'process.stdout.write(\'{"ready":true}\\n\'); setTimeout(() => process.exit(42), 50)'],
        cwd: process.cwd(),
      },
      onExit: (code) => {
        receivedCode = code;
        exitCount += 1;
      },
      healthTimeoutMs: 3000,
    });

    await handle.start();
    await waitFor(() => receivedCode !== undefined, 2000);
    expect(receivedCode).toBe(42);
    expect(exitCount).toBe(1);
    handle = undefined;
  });

  it('calls onReady when the process signals readiness', async () => {
    let ready = false;

    handle = createProcessLifecycle({
      spawn: {
        command: 'node',
        args: ['-e', 'process.stdout.write(\'{"ready":true}\\n\'); setTimeout(() => {}, 5000)'],
        cwd: process.cwd(),
      },
      onReady: () => {
        ready = true;
      },
      healthTimeoutMs: 3000,
    });

    await handle.start();
    expect(ready).toBe(true);
  });

  it('restarts on crash when restartPolicy is on-crash', async () => {
    const states: ProcessState[] = [];
    const restartDir = mkdtempSync(join(tmpdir(), 'makaio-process-lifecycle-'));
    const restartMarker = join(restartDir, 'first-run-complete');

    handle = createProcessLifecycle({
      spawn: {
        command: 'node',
        args: [
          '-e',
          // First run: signal ready then crash after 100ms.
          // Subsequent runs: stay alive so the test can observe running state.
          `
const fs = require('node:fs');
const marker = process.env.MAKAIO_RESTART_MARKER;
process.stdout.write('{"ready":true}\\n');
if (!marker) process.exit(2);
if (fs.existsSync(marker)) {
  setTimeout(() => {}, 60000);
} else {
  fs.writeFileSync(marker, 'done');
  setTimeout(() => process.exit(1), 100);
}
`,
        ],
        cwd: process.cwd(),
        env: { MAKAIO_RESTART_MARKER: restartMarker },
      },
      restartPolicy: 'on-crash',
      onStateChange: (s) => states.push(s),
      healthTimeoutMs: 3000,
    });

    try {
      await handle.start();
      expect(handle.state).toBe('running');

      // Wait for crash then restart cycle: running → crashed → starting → running
      await waitFor(() => {
        const ri = states.lastIndexOf('running');
        const ci = states.lastIndexOf('crashed');
        return ri > ci && ci !== -1;
      }, 5000);

      // Verify the sequence contains the restart cycle
      expect(states).toContain('crashed');
      const firstRunning = states.indexOf('running');
      const crashed = states.indexOf('crashed');
      const secondRunning = states.lastIndexOf('running');
      expect(crashed).toBeGreaterThan(firstRunning);
      expect(secondRunning).toBeGreaterThan(crashed);
      expect(handle.state).toBe('running');
    } finally {
      rmSync(restartDir, { recursive: true, force: true });
    }
  });

  it('stop() is idempotent when already stopped', async () => {
    handle = createProcessLifecycle({
      spawn: {
        command: 'node',
        args: ['-e', 'process.stdout.write(\'{"ready":true}\\n\'); setTimeout(() => {}, 5000)'],
        cwd: process.cwd(),
      },
      healthTimeoutMs: 3000,
    });

    await handle.start();
    await handle.stop();
    // Second stop must not throw
    await expect(handle.stop()).resolves.toBeUndefined();
    handle = undefined;
  });

  it('stop() is a no-op when state is idle', async () => {
    handle = createProcessLifecycle({
      spawn: { command: 'node', args: ['-e', ''], cwd: process.cwd() },
    });

    await expect(handle.stop()).resolves.toBeUndefined();
    expect(handle.state).toBe('idle');
    handle = undefined;
  });
});
