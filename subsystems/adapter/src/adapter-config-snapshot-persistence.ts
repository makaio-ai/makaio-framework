import { type AdapterFile, type ProviderConfigFile } from '@makaio/contracts/config';
import { type IAdapterConfigRepository } from '@makaio/services-core/adapter-subsystem';
import { type SnapshotState } from './adapter-subsystem-types.js';

/**
 * One file-level persistence operation that must be applied to move the
 * canonical adapter-config snapshot from one state to another.
 *
 * The `key` field is a unique human-readable identifier used in rollback error
 * messages.
 */
export type SnapshotPersistenceOperation =
  | {
      readonly kind: 'write-provider';
      readonly key: string;
      readonly id: string;
      readonly next: ProviderConfigFile;
      readonly previous?: ProviderConfigFile;
    }
  | {
      readonly kind: 'write-adapter';
      readonly key: string;
      readonly name: string;
      readonly next: AdapterFile;
      readonly previous?: AdapterFile;
    }
  | {
      readonly kind: 'delete-provider';
      readonly key: string;
      readonly id: string;
      readonly previous: ProviderConfigFile;
    };

/**
 * Build the ordered persistence plan required to move one snapshot to another.
 * @param currentSnapshot - Raw snapshot currently represented on disk and in memory.
 * @param nextSnapshot - Raw snapshot the service wants to commit.
 * @returns File-level persistence operations in commit order.
 */
export function buildSnapshotPersistenceOperations(
  currentSnapshot: SnapshotState,
  nextSnapshot: SnapshotState,
): SnapshotPersistenceOperation[] {
  const operations: SnapshotPersistenceOperation[] = [];

  for (const [id, nextConfig] of nextSnapshot.providerConfigs) {
    const previousConfig = currentSnapshot.providerConfigs.get(id);
    if (previousConfig === nextConfig) {
      continue;
    }
    operations.push({ kind: 'write-provider', key: `provider:${id}`, id, next: nextConfig, previous: previousConfig });
  }

  for (const [name, nextConfig] of nextSnapshot.adapters) {
    const previousConfig = currentSnapshot.adapters.get(name);
    if (previousConfig === nextConfig) {
      continue;
    }
    operations.push({
      kind: 'write-adapter',
      key: `adapter:${name}`,
      name,
      next: nextConfig,
      previous: previousConfig,
    });
  }

  for (const [id, previousConfig] of currentSnapshot.providerConfigs) {
    if (!nextSnapshot.providerConfigs.has(id)) {
      operations.push({ kind: 'delete-provider', key: `provider-delete:${id}`, id, previous: previousConfig });
    }
  }

  return operations;
}

/**
 * Apply one snapshot persistence operation against the repository seam.
 * @param repository - Repository responsible for the canonical file tree.
 * @param operation - File-level mutation to apply.
 * @returns Resolves after the operation is durably persisted.
 */
export async function applySnapshotPersistenceOperation(
  repository: IAdapterConfigRepository,
  operation: SnapshotPersistenceOperation,
): Promise<void> {
  switch (operation.kind) {
    case 'write-provider':
      await repository.writeProviderConfig(operation.id, operation.next);
      return;
    case 'write-adapter':
      await repository.writeAdapterFile(operation.name, operation.next);
      return;
    case 'delete-provider':
      if (!(await repository.deleteProviderConfig(operation.id))) {
        throw new Error(`Provider config file missing during delete: ${operation.id}`);
      }
      return;
  }
}

/**
 * Undo one previously applied snapshot persistence operation.
 * @param repository - Repository responsible for the canonical file tree.
 * @param operation - Applied operation that must be reverted.
 * @returns Resolves after the repository is restored to the previous file state.
 */
export async function rollbackSnapshotPersistenceOperation(
  repository: IAdapterConfigRepository,
  operation: SnapshotPersistenceOperation,
): Promise<void> {
  switch (operation.kind) {
    case 'write-provider':
      if (operation.previous) {
        await repository.writeProviderConfig(operation.id, operation.previous);
        return;
      }
      await repository.deleteProviderConfig(operation.id);
      return;
    case 'write-adapter':
      if (operation.previous) {
        await repository.writeAdapterFile(operation.name, operation.previous);
        return;
      }
      await repository.deleteAdapterFile(operation.name);
      return;
    case 'delete-provider':
      await repository.writeProviderConfig(operation.id, operation.previous);
      return;
  }
}

/**
 * Apply each operation in order; on any failure, roll back all previously
 * applied operations in reverse order.
 *
 * The in-memory snapshot must be replaced only after this promise resolves
 * successfully. If both the commit and the rollback fail, the error is wrapped
 * in an {@link AggregateError} so the caller can distinguish the two failures.
 * @param repository - Repository responsible for the canonical file tree.
 * @param currentSnapshot - Snapshot currently held in memory (used to derive
 *   the operations list).
 * @param nextSnapshot - Snapshot the caller wants to commit.
 * @returns Resolves when all operations have been durably persisted.
 */
export async function commitSnapshotPersistence(
  repository: IAdapterConfigRepository,
  currentSnapshot: SnapshotState,
  nextSnapshot: SnapshotState,
): Promise<void> {
  const operations = buildSnapshotPersistenceOperations(currentSnapshot, nextSnapshot);
  if (operations.length === 0) {
    return;
  }

  const applied: SnapshotPersistenceOperation[] = [];

  try {
    for (const operation of operations) {
      // The repository seam can mutate durable state and then reject. Mark the
      // current operation rollback-eligible before awaiting so disk is restored
      // against the in-memory snapshot even on after-write failures.
      applied.push(operation);
      await applySnapshotPersistenceOperation(repository, operation);
    }
  } catch (error) {
    try {
      await rollbackSnapshotPersistence(repository, applied);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'Adapter subsystem snapshot commit failed and rollback could not restore the previous state.',
        { cause: rollbackError },
      );
    }

    throw error;
  }
}

/**
 * Roll back all previously applied persistence operations in reverse order.
 *
 * Each individual rollback failure is captured and, if any occur, they are
 * collected into a single {@link AggregateError}.
 * @param repository - Repository responsible for the canonical file tree.
 * @param applied - Operations that have already been applied and must be
 *   reverted, in the order they were applied.
 * @returns Resolves when all rollback operations finish (including partial
 *   failures — thrown as an {@link AggregateError}).
 */
export async function rollbackSnapshotPersistence(
  repository: IAdapterConfigRepository,
  applied: readonly SnapshotPersistenceOperation[],
): Promise<void> {
  const rollbackErrors: Error[] = [];

  for (const operation of [...applied].reverse()) {
    try {
      await rollbackSnapshotPersistenceOperation(repository, operation);
    } catch (error) {
      rollbackErrors.push(
        error instanceof Error
          ? new Error(`[${operation.key}] ${error.message}`, { cause: error })
          : new Error(`[${operation.key}] ${String(error)}`),
      );
    }
  }

  if (rollbackErrors.length > 0) {
    throw new AggregateError(rollbackErrors, 'Snapshot rollback failed.');
  }
}
