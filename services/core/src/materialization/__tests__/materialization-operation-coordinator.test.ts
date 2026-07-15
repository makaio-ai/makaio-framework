import { describe, expect, it } from 'vitest';
import { MaterializationOperationCoordinator } from '../materialization-operation-coordinator.js';

const artifactScope = { artifactId: 'artifact-1' };
const providerScope = {
  artifactId: 'artifact-1',
  providerObjects: [{ provider: 'github', externalId: 'issue-1' }],
};

describe('MaterializationOperationCoordinator', () => {
  it('serializes same-scope leases in FIFO order', async () => {
    const coordinator = new MaterializationOperationCoordinator();
    const first = await coordinator.acquire(artifactScope);
    const order: string[] = [];
    const second = coordinator.acquire(artifactScope).then((lease) => {
      order.push('second');
      coordinator.release(lease);
    });

    await Promise.resolve();
    expect(order).toEqual([]);
    coordinator.release(first);
    await second;
    expect(order).toEqual(['second']);
  });

  it('allows disjoint artifact leases to proceed in parallel', async () => {
    const coordinator = new MaterializationOperationCoordinator();
    const first = await coordinator.acquire(artifactScope);
    const second = await coordinator.acquire({ artifactId: 'artifact-2' });

    coordinator.release(second);
    coordinator.release(first);
  });

  it('rejects new leases after destroy begins', async () => {
    const coordinator = new MaterializationOperationCoordinator();

    await coordinator.destroy();

    await expect(coordinator.acquire(artifactScope)).rejects.toThrow('coordinator is destroyed');
  });

  it('waits for held leases before completing destroy', async () => {
    const coordinator = new MaterializationOperationCoordinator();
    const lease = await coordinator.acquire(artifactScope);
    let destroyed = false;
    const destroy = coordinator.destroy().then(() => {
      destroyed = true;
    });

    await Promise.resolve();
    expect(destroyed).toBe(false);

    coordinator.release(lease);
    await destroy;
    expect(destroyed).toBe(true);
  });

  it('drains an admitted acquisition that becomes active while destroy waits', async () => {
    const coordinator = new MaterializationOperationCoordinator();
    const first = await coordinator.acquire(artifactScope);
    const secondAcquisition = coordinator.acquire(artifactScope);
    let destroyed = false;
    const destroy = coordinator.destroy().then(() => {
      destroyed = true;
    });

    coordinator.release(first);
    const second = await secondAcquisition;

    expect(destroyed).toBe(false);
    coordinator.release(second);
    await destroy;
    expect(destroyed).toBe(true);
  });

  it('extends an artifact lease with sorted provider-object keys', async () => {
    const coordinator = new MaterializationOperationCoordinator();
    const lease = await coordinator.acquire(artifactScope);

    await coordinator.extend(lease, {
      artifactId: 'artifact-1',
      providerObjects: [
        { provider: 'github', externalId: 'issue-2' },
        { provider: 'github', externalId: 'issue-1' },
        { provider: 'github', externalId: 'issue-1' },
      ],
    });
    coordinator.release(lease);
  });

  it('rejects a descending provider-object extension', async () => {
    const coordinator = new MaterializationOperationCoordinator();
    const lease = await coordinator.acquire({
      artifactId: 'artifact-1',
      providerObjects: [{ provider: 'github', externalId: 'issue-2' }],
    });

    await expect(
      coordinator.extend(lease, {
        artifactId: 'artifact-1',
        providerObjects: [{ provider: 'github', externalId: 'issue-1' }],
      }),
    ).rejects.toThrow('violates lock ordering');

    coordinator.release(lease);
  });

  it('uses the same locale-independent order for mixed-case provider keys', async () => {
    const coordinator = new MaterializationOperationCoordinator();
    const first = await coordinator.acquire({
      artifactId: 'artifact-1',
      providerObjects: [{ provider: 'github', externalId: 'Z' }],
    });
    const secondPromise = coordinator.acquire({
      artifactId: 'artifact-2',
      providerObjects: [
        { provider: 'github', externalId: 'a' },
        { provider: 'github', externalId: 'Z' },
      ],
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    await coordinator.extend(first, {
      artifactId: 'artifact-1',
      providerObjects: [{ provider: 'github', externalId: 'a' }],
    });

    coordinator.release(first);
    const second = await secondPromise;
    coordinator.release(second);
  });

  it('rejects authorization for provider objects the lease does not hold', async () => {
    const coordinator = new MaterializationOperationCoordinator();
    const lease = await coordinator.acquire(artifactScope);

    await expect(coordinator.runAuthorizedRequest(lease, providerScope, async () => undefined)).rejects.toThrow(
      'requires a lease for the full scope',
    );

    coordinator.release(lease);
  });

  it('consumes authorized requests exactly once and fails closed for wrong scopes and replays', async () => {
    const coordinator = new MaterializationOperationCoordinator();
    const lease = await coordinator.acquire(providerScope);
    let authorizedMessageId = '';
    let replayError: unknown;

    await coordinator.runAuthorizedRequest(lease, providerScope, async (messageId) => {
      authorizedMessageId = messageId;
      await coordinator.runExclusive(providerScope, async () => undefined, messageId, { local: true });
      try {
        await coordinator.runExclusive(providerScope, async () => undefined, messageId, { local: true });
      } catch (error) {
        replayError = error;
      }
    });

    expect(authorizedMessageId).not.toBe('');
    expect(replayError).toBeInstanceOf(Error);
    expect((replayError as Error).message).toContain('already been consumed');

    await expect(
      coordinator.runAuthorizedRequest(lease, providerScope, async (messageId) =>
        coordinator.runExclusive({ artifactId: 'artifact-2' }, async () => undefined, messageId, { local: true }),
      ),
    ).rejects.toThrow('does not match this scope');

    coordinator.release(lease);
  });

  it('rejects an authorized request received from a remote origin', async () => {
    const coordinator = new MaterializationOperationCoordinator();
    const lease = await coordinator.acquire(providerScope);

    await expect(
      coordinator.runAuthorizedRequest(lease, providerScope, (messageId) =>
        coordinator.runExclusive(providerScope, async () => undefined, messageId, { local: false }),
      ),
    ).rejects.toThrow('does not match this scope');

    coordinator.release(lease);
  });
});
