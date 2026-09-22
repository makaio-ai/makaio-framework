/**
 * Isolated coverage for a synchronous `new Worker()` construction failure in
 * {@link resolveExportedPackageCritical}.
 *
 * `node:worker_threads` cannot be made to throw synchronously from its
 * constructor on demand from a test — that failure mode is a thread-creation
 * refusal under a resource limit (e.g. the OS refusing a new native thread),
 * not something reachable via any public `Worker` option. This file mocks
 * `node:worker_threads`'s `Worker` export with a minimal stand-in whose
 * constructor throws, to exercise exactly the code path a real refusal would
 * take. It lives in its own file, rather than alongside
 * `exported-package-critical.test.ts`'s real-worker tests, because
 * `vi.mock` is hoisted file-wide and would otherwise replace the `Worker`
 * every other test in that file depends on to actually import a module.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('node:worker_threads', () => ({
  Worker: class ThrowingWorker {
    constructor() {
      throw new Error('EAGAIN: resource temporarily unavailable, uv_thread_create');
    }
  },
}));

describe('resolveExportedPackageCritical (synchronous Worker construction failure)', () => {
  it('warns and resolves undefined instead of rejecting when `new Worker()` throws synchronously', async () => {
    const { resolveExportedPackageCritical } = await import('../exported-package-critical.js');

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exported-package-critical-worker-ctor-test-'));
    try {
      const modulePath = path.join(tempDir, 'server.mjs');
      await fs.writeFile(
        modulePath,
        `export default { name: 'ctor-fail-ext', displayName: 'Ctor Fail', version: '1.0.0', critical: true };\n`,
      );

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const critical = await resolveExportedPackageCritical(modulePath, 'ctor-fail-ext', '[test] ctor-fail-ext');

        expect(critical).toBeUndefined();
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('[test] ctor-fail-ext: failed to import server entry'),
          expect.anything(),
        );
      } finally {
        warnSpy.mockRestore();
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
