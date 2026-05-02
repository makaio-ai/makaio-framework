type TTYValue = boolean | undefined;

export interface TestTTYFixture {
  snapshot(): void;
  set(values: { stdoutIsTTY?: TTYValue; stdinIsTTY?: TTYValue }): void;
  restore(): void;
}

/**
 * Snapshot and restore stdio `isTTY` descriptors exactly as Node exposed them.
 *
 * Tests need descriptor-aware restore logic because some environments inherit
 * `isTTY` while others install it as an own property. Re-using one fixture
 * keeps the interactive CLI tests from drifting into subtly different cleanup.
 * @param stdio - Process stdio handles to control for the test.
 * @returns Fixture with snapshot, mutate, and restore operations.
 */
export function createTestTTYFixture(stdio: Pick<NodeJS.Process, 'stdin' | 'stdout'> = process): TestTTYFixture {
  let hadOwnStdoutIsTTY = false;
  let hadOwnStdinIsTTY = false;
  let originalStdoutIsTTYDescriptor: PropertyDescriptor | undefined;
  let originalStdinIsTTYDescriptor: PropertyDescriptor | undefined;
  let snapshotted = false;

  return {
    snapshot(): void {
      hadOwnStdoutIsTTY = Object.prototype.hasOwnProperty.call(stdio.stdout, 'isTTY');
      hadOwnStdinIsTTY = Object.prototype.hasOwnProperty.call(stdio.stdin, 'isTTY');
      originalStdoutIsTTYDescriptor = Object.getOwnPropertyDescriptor(stdio.stdout, 'isTTY');
      originalStdinIsTTYDescriptor = Object.getOwnPropertyDescriptor(stdio.stdin, 'isTTY');
      snapshotted = true;
    },

    set(values): void {
      if (!snapshotted) {
        // `set()` only makes sense after `snapshot()` has captured whether each
        // handle inherited `isTTY` or owned the descriptor directly.
        throw new Error('createTestTTYFixture.set() requires snapshot() before mutating stdio handles.');
      }

      if (Object.prototype.hasOwnProperty.call(values, 'stdoutIsTTY')) {
        Object.defineProperty(stdio.stdout, 'isTTY', {
          value: values.stdoutIsTTY,
          configurable: true,
          writable: true,
        });
      }
      if (Object.prototype.hasOwnProperty.call(values, 'stdinIsTTY')) {
        Object.defineProperty(stdio.stdin, 'isTTY', {
          value: values.stdinIsTTY,
          configurable: true,
          writable: true,
        });
      }
    },

    restore(): void {
      if (!snapshotted) {
        return;
      }

      if (hadOwnStdoutIsTTY && originalStdoutIsTTYDescriptor) {
        Object.defineProperty(stdio.stdout, 'isTTY', originalStdoutIsTTYDescriptor);
      } else {
        delete (stdio.stdout as { isTTY?: boolean }).isTTY;
      }

      if (hadOwnStdinIsTTY && originalStdinIsTTYDescriptor) {
        Object.defineProperty(stdio.stdin, 'isTTY', originalStdinIsTTYDescriptor);
      } else {
        delete (stdio.stdin as { isTTY?: boolean }).isTTY;
      }

      snapshotted = false;
    },
  };
}
