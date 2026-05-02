import PQueue from 'p-queue';
import { runAdapterTests } from './runner.js';
import { writeConformanceArtifacts } from './artifacts.js';
import type { AdapterResult } from './types.js';

type RunAdapter = typeof runAdapterTests;

export interface RunAdapterQueueWithSchemaArtifactOptions {
  /** Adapter names to execute. */
  adapters: string[];
  /** Test files to pass to each adapter run. */
  testFiles: string[];
  /** Optional regex pattern to filter tests by name. */
  testNamePattern?: string;
  /** Optional per-adapter concurrency override. */
  concurrencyOverride?: number;
  /** Max adapters to run concurrently. */
  adapterParallelism: number;
  /** Whether adapter execution should emit verbose test output. */
  verbose: boolean;
  /** Optional max worker count to pass to Vitest. */
  workers?: number;
  /** Mutable result sink, provided by CLI so it can still print partial results after a crash. */
  results: AdapterResult[];
  /** Schema violation artifact path to write after the queue settles or rejects. */
  schemaViolationsPath: string;
  /** Optional phase label to store in the result artifact. */
  phase?: string;
  /** Optional path for the machine-readable result artifact. */
  resultOutputPath?: string;
  /** Test seam for exercising queue failure behavior. */
  runAdapter?: RunAdapter;
}

/**
 * Runs adapter conformance tests and always writes the schema-violation artifact.
 * @param options - Adapter execution and artifact options
 * @returns Adapter results collected before completion
 */
export async function runAdapterQueueWithSchemaArtifact(
  options: RunAdapterQueueWithSchemaArtifactOptions,
): Promise<AdapterResult[]> {
  const adapterQueue = new PQueue({ concurrency: options.adapterParallelism });
  const runAdapter = options.runAdapter ?? runAdapterTests;

  const adapterPromises = options.adapters.map((adapter) =>
    adapterQueue.add(async () => {
      const result = await runAdapter(
        adapter,
        options.testFiles,
        options.testNamePattern,
        options.concurrencyOverride,
        options.verbose,
        options.workers,
      );
      options.results.push(result);
    }),
  );

  const settled = await Promise.allSettled(adapterPromises);

  await writeConformanceArtifacts({
    results: options.results,
    phase: options.phase,
    testFiles: options.testFiles,
    resultOutputPath: options.resultOutputPath,
    schemaViolationsOutputPath: options.schemaViolationsPath,
  });

  const rejected = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (rejected) {
    throw rejected.reason;
  }
  return options.results;
}
