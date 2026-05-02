import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import type { AdapterResult, ConformanceRunArtifact, ConformanceRunEntry, ConformanceRunStatus } from './types.js';
import { CONFORMANCE_PATH } from './types.js';

export interface WriteConformanceArtifactsOptions {
  /** Adapter results collected during the runner invocation. */
  results: AdapterResult[];
  /** Optional phase label to store in the result artifact. */
  phase?: string;
  /** Absolute conformance test file paths included in this invocation. */
  testFiles: string[];
  /** Optional path for the machine-readable result artifact. */
  resultOutputPath?: string;
  /** Required path for the schema-violation artifact. */
  schemaViolationsOutputPath: string;
}

/**
 * Derives the high-level status for one adapter result.
 * @param result - Adapter result collected from Vitest
 * @returns Status for CI report rendering
 */
function toRunStatus(result: AdapterResult): ConformanceRunStatus {
  if (result.failed > 0 || result.errors.length > 0 || result.unhandledErrors.length > 0) return 'failed';
  if (result.passed === 0 && result.skipped === 0) return 'failed';
  if (result.passed === 0 && result.skipped > 0) return 'skipped';
  return 'passed';
}

/**
 * Converts a runner result into the stable JSON artifact shape consumed by CI.
 * @param result - Adapter result collected from Vitest
 * @param testFiles - Test files included in this runner invocation
 * @returns Serializable conformance run entry
 */
function toRunEntry(result: AdapterResult, testFiles: string[]): ConformanceRunEntry {
  return {
    ...result,
    status: toRunStatus(result),
    testFiles: testFiles.map((file) => relative(CONFORMANCE_PATH, file)),
  };
}

/**
 * Writes the machine-readable conformance result and schema-violation artifacts.
 *
 * The schema-violation artifact is always written so CI can distinguish a clean
 * run from a runner failure that never reached artifact emission.
 * @param options - Artifact data and output paths
 */
export async function writeConformanceArtifacts(options: WriteConformanceArtifactsOptions): Promise<void> {
  const { results, phase, testFiles, resultOutputPath, schemaViolationsOutputPath } = options;
  const allViolations = results.flatMap((r) => r.schemaViolations.map((v) => ({ adapter: r.adapter, ...v })));

  await mkdir(dirname(schemaViolationsOutputPath), { recursive: true });
  await writeFile(schemaViolationsOutputPath, JSON.stringify(allViolations, null, 2));

  if (!resultOutputPath) return;

  const artifact: ConformanceRunArtifact = {
    schemaVersion: 1,
    phase,
    generatedAt: new Date().toISOString(),
    runs: results.map((result) => toRunEntry(result, testFiles)),
  };

  await mkdir(dirname(resultOutputPath), { recursive: true });
  await writeFile(resultOutputPath, JSON.stringify(artifact, null, 2));
}
