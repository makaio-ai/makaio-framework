import { describe, expect, it } from 'vitest';
import { JoinedOperation } from '../joined-operation.js';

describe('JoinedOperation', () => {
  it('lets a call made from the synchronous prefix of start join the run under way', async () => {
    const operation = new JoinedOperation<string>();
    let starts = 0;
    let nested: Promise<string> | undefined;

    const outer = operation.join(() => {
      starts += 1;
      nested = operation.join(() => {
        starts += 1;
        return 'second';
      });
      return 'first';
    });

    expect(nested).toBe(outer);
    expect(starts).toBe(1);
    await expect(outer).resolves.toBe('first');
  });

  it('shares one run between concurrent callers and keeps its outcome after it settles', async () => {
    const operation = new JoinedOperation<number>();
    let starts = 0;
    const start = (): Promise<number> => Promise.resolve(++starts);

    const [first, second] = [operation.join(start), operation.join(start)];
    expect(second).toBe(first);
    await expect(first).resolves.toBe(1);
    await expect(operation.join(start)).resolves.toBe(1);
    expect(starts).toBe(1);
  });

  it('turns a synchronous throw into the rejection every caller sees', async () => {
    const operation = new JoinedOperation<void>();
    const failure = new Error('boom');
    const first = operation.join(() => {
      throw failure;
    });

    await expect(first).rejects.toBe(failure);
    await expect(operation.join(() => undefined)).rejects.toBe(failure);
  });

  it('starts a new run after the run releases itself, and ignores a stale release', async () => {
    const operation = new JoinedOperation<string>();
    let releaseFirst: () => void = () => undefined;
    const first = operation.join((forget) => {
      releaseFirst = forget;
      return 'first';
    });
    await first;

    operation.forget();
    const second = operation.join(() => 'second');
    releaseFirst();

    expect(operation.current).toBe(second);
    await expect(second).resolves.toBe('second');
  });
});
