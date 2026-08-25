import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPPORTUNISTIC_RETRY_COOLDOWN_MS, RetainedProgramRoots } from '../retained-program-roots.js';
import type { ProgramRootLease } from '../virtual-program-materializer.js';

// Fake root path used across cases; never touches the filesystem.
const ROOT_A = '/tmp/makaio-code-execution-aaaaaa';

/**
 * Build a minimal fake {@link ProgramRootLease} for use with
 * {@link RetainedProgramRoots.release}.
 * @param root - Absolute program root path.
 * @param cleanup - Cleanup function to attach.
 * @returns Fake program handle satisfying the interface.
 */
const makeProgram = (root: string, cleanup: () => Promise<boolean>): ProgramRootLease => ({
  root,
  cleanup,
});

/**
 * Build a removal wrapper that counts calls and always resolves to the given result.
 *
 * The returned `callCount` getter reflects every invocation made after construction.
 * @param result - Value the removal function resolves to.
 * @returns Object with the wrapped function and a live `callCount`.
 */
const makeCountingRemoval = (result: boolean) => {
  let callCount = 0;
  const remove = async (_root: string): Promise<boolean> => {
    callCount += 1;
    return result;
  };
  return {
    remove,
    get callCount() {
      return callCount;
    },
  };
};

describe('RetainedProgramRoots', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('retry (opportunistic path)', () => {
    it('skips a root whose last attempt falls within the cooldown', async () => {
      const counter = makeCountingRemoval(false);
      const retained = new RetainedProgramRoots(counter.remove);
      // release() uses program.cleanup(), not the injected removeRoot, so the counter
      // stays at zero while the root is retained with a fresh timestamp.
      await retained.release(makeProgram(ROOT_A, async () => false));

      // Retry immediately — no time has advanced, so the root is within the cooldown.
      await retained.retry([ROOT_A]);

      expect(counter.callCount).toBe(0);
      expect(retained.pending).toEqual([ROOT_A]);
    });

    it('attempts a root once the cooldown has elapsed', async () => {
      const counter = makeCountingRemoval(false);
      const retained = new RetainedProgramRoots(counter.remove);
      await retained.release(makeProgram(ROOT_A, async () => false));

      vi.advanceTimersByTime(OPPORTUNISTIC_RETRY_COOLDOWN_MS);
      await retained.retry([ROOT_A]);

      expect(counter.callCount).toBe(1);
    });

    it('removes a root from pending when a post-cooldown attempt succeeds', async () => {
      const counter = makeCountingRemoval(true);
      const retained = new RetainedProgramRoots(counter.remove);
      await retained.release(makeProgram(ROOT_A, async () => false));

      vi.advanceTimersByTime(OPPORTUNISTIC_RETRY_COOLDOWN_MS);
      await retained.retry([ROOT_A]);

      expect(counter.callCount).toBe(1);
      expect(retained.pending).toEqual([]);
    });

    it('does not retry a root from a stale snapshot after another path removed it', async () => {
      const counter = makeCountingRemoval(true);
      const retained = new RetainedProgramRoots(counter.remove);
      await retained.release(makeProgram(ROOT_A, async () => false));
      const staleSnapshot = retained.pending;

      await retained.retryAll();
      vi.advanceTimersByTime(OPPORTUNISTIC_RETRY_COOLDOWN_MS);
      await retained.retry(staleSnapshot);

      expect(counter.callCount).toBe(1);
      expect(retained.pending).toEqual([]);
    });

    it('coalesces overlapping retries for one retained root', async () => {
      const removal = Promise.withResolvers<boolean>();
      let callCount = 0;
      const retained = new RetainedProgramRoots(() => {
        callCount += 1;
        return removal.promise;
      });
      await retained.release(makeProgram(ROOT_A, async () => false));
      vi.advanceTimersByTime(OPPORTUNISTIC_RETRY_COOLDOWN_MS);

      const first = retained.retry([ROOT_A]);
      const second = retained.retry([ROOT_A]);
      expect(callCount).toBe(1);
      removal.resolve(true);
      await Promise.all([first, second]);

      expect(retained.pending).toEqual([]);
    });
  });

  describe('retryAll (dispose path)', () => {
    it('attempts every retained root regardless of the cooldown', async () => {
      const counter = makeCountingRemoval(false);
      const retained = new RetainedProgramRoots(counter.remove);
      await retained.release(makeProgram(ROOT_A, async () => false));

      // No time has advanced — still within the cooldown window.
      await retained.retryAll();

      expect(counter.callCount).toBe(1);
    });

    it('returns roots that survived the disposal round', async () => {
      const counter = makeCountingRemoval(false);
      const retained = new RetainedProgramRoots(counter.remove);
      await retained.release(makeProgram(ROOT_A, async () => false));

      const surviving = await retained.retryAll();

      expect(surviving).toEqual([ROOT_A]);
    });

    it('excludes a successfully disposed root from the returned list', async () => {
      const counter = makeCountingRemoval(true);
      const retained = new RetainedProgramRoots(counter.remove);
      await retained.release(makeProgram(ROOT_A, async () => false));

      const surviving = await retained.retryAll();

      expect(counter.callCount).toBe(1);
      expect(surviving).toEqual([]);
    });
  });
});
