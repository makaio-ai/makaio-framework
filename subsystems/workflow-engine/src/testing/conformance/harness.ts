import { afterAll, beforeAll } from 'vitest';
import type { OutcomeCodec } from '../../execution-attempt-repository.js';
import type { ExecutionAttemptRepositoryContractFactory, ExecutionAttemptRepositoryContractHarness } from './types.js';

/**
 * Bind one realization to the surrounding Vitest suite's lifetime.
 * @param factory - Factory responsible for releasing resources if setup fails.
 * @param codec - Owner outcome codec exercised by this suite.
 * @returns Accessor used only after the suite's setup has completed.
 * @typeParam TOutcome - Outcome type for the current group of requirements.
 */
export function useHarness<TOutcome>(
  factory: ExecutionAttemptRepositoryContractFactory,
  codec: OutcomeCodec<TOutcome>,
): () => ExecutionAttemptRepositoryContractHarness<TOutcome> {
  let harness: ExecutionAttemptRepositoryContractHarness<TOutcome> | undefined;
  beforeAll(async () => {
    harness = await factory.create(codec);
  });
  afterAll(async () => {
    // A rejected factory already owns partial cleanup; do not hide its failure
    // behind an attempt to dispose a harness that was never returned.
    await harness?.dispose();
  });
  return () => {
    if (!harness) throw new Error('Repository conformance harness has not been initialized');
    return harness;
  };
}
