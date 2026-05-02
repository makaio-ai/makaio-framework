import { afterEach, describe, expect, it } from 'vitest';

import { createTestTTYFixture } from './test-tty-fixture.js';

describe('createTestTTYFixture', () => {
  const ttyFixture = createTestTTYFixture();

  afterEach(() => {
    ttyFixture.restore();
  });

  it('throws when set() is called before snapshot()', () => {
    const originalStdoutIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    const originalStdinIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');

    expect(() => {
      ttyFixture.set({ stdoutIsTTY: true, stdinIsTTY: true });
    }).toThrow('requires snapshot() before mutating stdio handles');

    expect(Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')).toStrictEqual(originalStdoutIsTTYDescriptor);
    expect(Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')).toStrictEqual(originalStdinIsTTYDescriptor);
  });

  it('restores the original stdio descriptors after mutation', () => {
    const originalStdoutIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    const originalStdinIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');

    ttyFixture.snapshot();
    ttyFixture.set({ stdoutIsTTY: true, stdinIsTTY: false });
    ttyFixture.restore();

    expect(Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')).toStrictEqual(originalStdoutIsTTYDescriptor);
    expect(Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')).toStrictEqual(originalStdinIsTTYDescriptor);
  });
});
