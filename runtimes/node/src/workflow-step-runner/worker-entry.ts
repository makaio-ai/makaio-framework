import { createStepCancelSubject, type StepRunConfig, type StepRunResult } from '@makaio/contracts';
import { bootWorkerBus, type WorkerBusHandle } from './worker-boot.js';
import { StepTelemetryCollector } from './step-telemetry-collector.js';
import { runWorkerShellStep } from './worker-shell-executor.js';
import { runWorkerAgentStep } from './worker-agent-executor.js';
import type { WorkerContributionManifest } from './types.js';
import { loadWorkerContributions } from './worker-contributions.js';
import { JSONRPC_READY_MESSAGE } from './worker-protocol.js';

/**
 * Parameters for running a workflow step inside an isolated worker.
 */
export interface WorkerRunStepParams {
  /** Step execution configuration from the orchestrator. */
  readonly config: StepRunConfig;
  /** Contribution manifest declaring which extension packages to load. */
  readonly manifest: WorkerContributionManifest;
  /** Optional abort signal for cooperative cancellation. */
  readonly signal?: AbortSignal;
}

/**
 * Execute a single workflow step in an isolated worker context.
 *
 * Orchestrates the full worker lifecycle:
 * 1. Boots an isolated bus instance (with optional WebSocket transport)
 * 2. Attaches a telemetry collector to capture token usage and tool calls
 * 3. Dispatches to the appropriate executor based on step type
 * 4. Merges the step result with collected telemetry
 * 5. Always closes the bus in the finally block
 * @param params - Worker run step parameters.
 * @returns Step result with merged telemetry from the local bus.
 */
export async function runStepInWorker(params: WorkerRunStepParams): Promise<StepRunResult> {
  const { config, manifest, signal } = params;
  const abortController = new AbortController();
  const abortFromParent = (): void => abortController.abort();
  if (signal?.aborted) {
    abortController.abort();
  } else {
    signal?.addEventListener('abort', abortFromParent, { once: true });
  }

  let handle: WorkerBusHandle | undefined;
  let collector: StepTelemetryCollector | undefined;
  let unsubscribeCancel: (() => void) | undefined;

  try {
    handle = await bootWorkerBus(config);
    unsubscribeCancel = handle.bus.on(createStepCancelSubject(config.cancelSubject), () => {
      abortController.abort();
    });
    collector = new StepTelemetryCollector(handle.bus);

    const contributions = await loadWorkerContributions(manifest, {
      bus: handle.bus,
      signal: abortController.signal,
    });

    let result: StepRunResult;

    if (config.stepType === 'shell') {
      result = await runWorkerShellStep(config, abortController.signal);
    } else {
      result = await runWorkerAgentStep(handle, config, abortController.signal, contributions);
    }

    // Merge telemetry from the collector into the step result
    const collectedTelemetry = collector.collect();
    return {
      ...result,
      telemetry: {
        ...result.telemetry,
        tokenUsage:
          collectedTelemetry.tokenUsage.input > 0 || collectedTelemetry.tokenUsage.output > 0
            ? collectedTelemetry.tokenUsage
            : result.telemetry.tokenUsage,
        toolCalls: collectedTelemetry.toolCalls > 0 ? collectedTelemetry.toolCalls : result.telemetry.toolCalls,
      },
    };
  } finally {
    signal?.removeEventListener('abort', abortFromParent);
    unsubscribeCancel?.();
    collector?.dispose();
    if (handle) {
      await handle.close();
    }
  }
}

// ---------------------------------------------------------------------------
// JSONL Command Mode (child-process/Docker runner entrypoint)
// ---------------------------------------------------------------------------

/**
 * Detect if this module is being run as the main entrypoint.
 *
 * When executed directly (e.g., `node worker-entry.mjs` or `tsx worker-entry.ts`),
 * reads a single JSON line from stdin, executes the step, and writes the result
 * as a JSON line to stdout.
 */
async function runAsMain(): Promise<void> {
  const input = await readJsonLineFromStdin();
  const params = input as WorkerRunStepParams;

  // Signal readiness to the parent process
  process.stdout.write(JSON.stringify(JSONRPC_READY_MESSAGE) + '\n');

  const result = await runStepInWorker(params);

  process.stdout.write(JSON.stringify(result) + '\n');
}

/**
 * Read a single JSON line from stdin.
 *
 * Buffers stdin data until a newline is encountered, then parses the
 * accumulated buffer as JSON. Rejects if stdin closes before a complete
 * line is received.
 * @returns Parsed JSON value from the first stdin line.
 */
function readJsonLineFromStdin(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer = '';

    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString();
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex !== -1) {
        cleanup();
        const line = buffer.slice(0, newlineIndex).trim();
        try {
          resolve(JSON.parse(line));
        } catch (err: unknown) {
          reject(new Error(`Failed to parse JSON from stdin: ${err instanceof Error ? err.message : String(err)}`));
        }
      }
    };

    const onEnd = (): void => {
      cleanup();
      if (buffer.trim()) {
        try {
          resolve(JSON.parse(buffer.trim()));
        } catch (err: unknown) {
          reject(new Error(`Failed to parse JSON from stdin: ${err instanceof Error ? err.message : String(err)}`));
        }
      } else {
        reject(new Error('stdin closed without providing input'));
      }
    };

    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };

    const cleanup = (): void => {
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.off('error', onError);
    };

    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.on('error', onError);
    process.stdin.resume();
  });
}

/**
 * Detect main-module execution.
 *
 * Uses `process.argv[1]` to check if the current file is the entrypoint.
 * Works for both ESM (`tsx worker-entry.ts`) and bundled (`node worker-entry.mjs`).
 * @returns `true` when this file is the direct execution target.
 */
function isMainModule(): boolean {
  const scriptPath = process.argv[1];
  if (!scriptPath) return false;

  // Check if the running script matches this file (handles both .ts and .mjs extensions)
  const thisFile = import.meta.url;
  const scriptUrl = scriptPath.startsWith('file://') ? scriptPath : `file://${scriptPath}`;
  return thisFile === scriptUrl;
}

if (isMainModule()) {
  runAsMain().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[worker-entry] Fatal: ${message}\n`);
    process.exitCode = 1;
  });
}

// Piscina targets the default export of the worker entrypoint.
export default runStepInWorker;
