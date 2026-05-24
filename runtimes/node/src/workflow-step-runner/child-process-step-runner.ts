import type { ChildProcess } from 'node:child_process';
import { createJsonlTransport, type IJsonlTransport } from '@makaio/subprocess';
import { StepRunResultSchema, type IStepRunner, type StepRunConfig, type StepRunResult } from '@makaio/contracts';
import type { ChildProcessStepRunnerOptions, WorkerContributionManifest } from './types.js';
import { isReadyMessage } from './worker-protocol.js';
import { buildNodeWorkerEntryArgs } from './worker-entry-resolver.js';

/**
 * Step runner that spawns isolated Node.js child processes for each step.
 *
 * Communication protocol:
 * 1. Parent spawns `node <workerEntry>` with `tsx` only for TypeScript source entries
 * 2. Parent writes `{ config, manifest }` as a JSON line to stdin
 * 3. Child writes a JSON-RPC-shaped ready notification when initialized
 * 4. Child writes the {@link StepRunResult} as a JSON line to stdout
 * 5. Parent parses the result and cleans up the process
 *
 * Each step gets full process-level isolation (separate V8 heap, event loop).
 */
export class ChildProcessStepRunner implements IStepRunner {
  public readonly managesWorkflowLifecycle = false;

  private readonly workerEntry: string;
  private readonly cwd: string;
  private readonly manifest: WorkerContributionManifest;
  private readonly active = new Map<string, ChildProcess>();

  /**
   * @param options - Child process runner configuration.
   */
  public constructor(options: ChildProcessStepRunnerOptions) {
    this.workerEntry = options.workerEntry;
    this.cwd = options.cwd;
    this.manifest = options.manifest;
  }

  /**
   * Execute a workflow step in an isolated child process.
   * @param config - Step configuration with definition, inputs, and bus info.
   * @param signal - AbortSignal for cooperative cancellation.
   * @returns Step result with functional output and telemetry.
   */
  public async run(config: StepRunConfig, signal: AbortSignal): Promise<StepRunResult> {
    const key = `${config.executionId}:${config.stepId}`;

    const transport = createJsonlTransport({
      command: 'node',
      args: buildNodeWorkerEntryArgs(this.workerEntry),
      cwd: this.cwd,
      processName: `step-worker:${key}`,
    });

    this.active.set(key, transport.process);

    try {
      return await this.executeWithTransport(transport, config, signal, key);
    } finally {
      this.active.delete(key);
      transport.close();
    }
  }

  /**
   * Force-kill a running step process immediately (SIGKILL).
   * @param executionId - Execution ID owning the step.
   * @param stepId - Identifier of the step to kill.
   */
  public forceKill(executionId: string, stepId: string): void {
    const key = `${executionId}:${stepId}`;
    const proc = this.active.get(key);
    if (proc) {
      proc.kill('SIGKILL');
    }
  }

  /**
   * Orchestrate the JSONL request/response exchange with the child process.
   * @param transport - JSONL transport wrapping the child process.
   * @param config - Step run configuration to send.
   * @param signal - AbortSignal for cancellation.
   * @param key - Composite key for tracking active processes.
   * @returns Parsed step result from the child process.
   */
  private executeWithTransport(
    transport: IJsonlTransport,
    config: StepRunConfig,
    signal: AbortSignal,
    key: string,
  ): Promise<StepRunResult> {
    return new Promise<StepRunResult>((resolve, reject) => {
      let receivedReady = false;
      let settled = false;
      let aborted = false;

      const settle = (action: () => void): void => {
        if (settled) return;
        settled = true;
        unsubMessage();
        unsubError();
        signal.removeEventListener('abort', onAbort);
        transport.process.off('exit', onExit);
        action();
      };

      const onAbort = (): void => {
        aborted = true;
        transport.process.kill('SIGTERM');
      };

      if (signal.aborted) {
        transport.close();
        reject(new Error(`Step ${key} aborted`));
        return;
      }

      signal.addEventListener('abort', onAbort);

      const unsubMessage = transport.onMessage((message: unknown) => {
        if (!receivedReady) {
          // First message should be the ready signal
          if (isReadyMessage(message)) {
            receivedReady = true;
            return;
          }
          // If first message isn't ready, treat it as the result (tolerant)
        }

        // Second message (or first non-ready message) is the result
        settle(() => {
          try {
            resolve(StepRunResultSchema.parse(message));
          } catch (parseError: unknown) {
            const detail = parseError instanceof Error ? parseError.message : String(parseError);
            reject(new Error(`Invalid StepRunResult from child process: ${detail}`));
          }
        });
      });

      const unsubError = transport.onError((error: Error) => {
        settle(() => reject(aborted ? new Error(`Step ${key} aborted`) : error));
      });

      const onExit = (code: number | null): void => {
        settle(() => {
          reject(
            aborted
              ? new Error(`Step ${key} aborted`)
              : new Error(`Child process for step ${key} exited with code ${String(code)} before producing a result`),
          );
        });
      };
      transport.process.once('exit', onExit);

      // Send the work payload to stdin
      transport.send({ config, manifest: this.manifest });
    });
  }
}
