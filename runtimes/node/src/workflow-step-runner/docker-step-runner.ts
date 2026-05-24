import { spawn, execFile } from 'node:child_process';
import { StepRunResultSchema, type IStepRunner, type StepRunConfig, type StepRunResult } from '@makaio/contracts';
import type { DockerStepRunnerOptions, WorkerContributionManifest } from './types.js';
import { decodeJsonlChunk } from '@makaio/subprocess';
import { isReadyMessage } from './worker-protocol.js';
import { buildNodeWorkerEntryArgs } from './worker-entry-resolver.js';

/**
 * Step runner that executes workflow steps inside Docker containers.
 *
 * Communication protocol:
 * 1. `docker create` with volume mounts and the worker entrypoint command
 * 2. `docker start --attach --interactive` to connect stdin/stdout
 * 3. Parent writes `{ config, manifest }` as a JSON line to the container's stdin
 * 4. Container writes a JSON-RPC-shaped ready notification followed by the result
 * 5. `docker rm -f` always removes the container in cleanup
 *
 * SECURITY: Secrets (busAuth) are NEVER passed via env vars or command args.
 * They are sent exclusively via stdin to prevent exposure in `docker inspect`
 * or `/proc` filesystem.
 */
export class DockerStepRunner implements IStepRunner {
  public readonly managesWorkflowLifecycle = false;

  private readonly imageName: string;
  private readonly workerEntry: string;
  private readonly cwd: string;
  private readonly manifest: WorkerContributionManifest;
  private readonly networkMode: string;
  private readonly activeContainers = new Map<string, string>();

  /**
   * @param options - Docker runner configuration.
   */
  public constructor(options: DockerStepRunnerOptions) {
    this.imageName = options.imageName;
    this.workerEntry = options.workerEntry;
    this.cwd = options.cwd;
    this.manifest = options.manifest;
    this.networkMode = options.networkMode ?? 'host';
  }

  /**
   * Execute a workflow step inside a Docker container.
   * @param config - Step configuration with definition, inputs, and bus info.
   * @param signal - AbortSignal for cooperative cancellation.
   * @returns Step result with functional output and telemetry.
   */
  public async run(config: StepRunConfig, signal: AbortSignal): Promise<StepRunResult> {
    const key = `${config.executionId}:${config.stepId}`;
    let containerId: string | undefined;

    try {
      containerId = await this.createContainer(key);
      this.activeContainers.set(key, containerId);

      return await this.startAndCommunicate(containerId, config, signal, key);
    } finally {
      this.activeContainers.delete(key);
      if (containerId) {
        await this.removeContainer(containerId);
      }
    }
  }

  /**
   * Force-kill a running container immediately.
   * @param executionId - Execution ID owning the step.
   * @param stepId - Identifier of the step to kill.
   */
  public async forceKill(executionId: string, stepId: string): Promise<void> {
    const key = `${executionId}:${stepId}`;
    const containerId = this.activeContainers.get(key);
    if (containerId) {
      await this.docker(['stop', '--time=0', containerId]);
    }
  }

  /**
   * Create a Docker container configured for step execution.
   * @param key - Composite key used as the container name suffix for diagnostics.
   * @returns The container ID.
   */
  private async createContainer(key: string): Promise<string> {
    const args = [
      'create',
      '--network',
      this.networkMode,
      '-v',
      `${this.cwd}:/workspace`,
      '-w',
      '/workspace',
      '--label',
      `makaio.step=${key}`,
      '-i', // Keep stdin open for communication
      this.imageName,
      'node',
      ...buildNodeWorkerEntryArgs(this.workerEntry),
    ];

    const { stdout } = await this.docker(args);
    return stdout.trim();
  }

  /**
   * Start the container in attached+interactive mode and perform the JSONL exchange.
   * @param containerId - Docker container ID to start.
   * @param config - Step run configuration.
   * @param signal - AbortSignal for cancellation.
   * @param key - Composite key for tracking.
   * @returns Parsed step result from the container.
   */
  private startAndCommunicate(
    containerId: string,
    config: StepRunConfig,
    signal: AbortSignal,
    key: string,
  ): Promise<StepRunResult> {
    return new Promise<StepRunResult>((resolve, reject) => {
      const proc = spawn('docker', ['start', '--attach', '--interactive', containerId], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let settled = false;
      let receivedReady = false;
      let stdoutBuffer = '';
      let aborted = false;

      const settle = (action: () => void): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        action();
      };

      const onAbort = (): void => {
        aborted = true;
        proc.kill('SIGTERM');
      };

      if (signal.aborted) {
        proc.kill('SIGTERM');
        reject(new Error(`Step ${key} aborted`));
        return;
      }

      signal.addEventListener('abort', onAbort);

      proc.stdout.on('data', (chunk: Buffer) => {
        const decoded = decodeJsonlChunk(chunk.toString('utf-8'), stdoutBuffer);
        stdoutBuffer = decoded.remaining;

        for (const message of decoded.messages) {
          if (!receivedReady) {
            if (isReadyMessage(message)) {
              receivedReady = true;
              continue;
            }
          }
          // Result message
          settle(() => {
            try {
              resolve(StepRunResultSchema.parse(message));
            } catch (parseError: unknown) {
              const detail = parseError instanceof Error ? parseError.message : String(parseError);
              reject(new Error(`Invalid StepRunResult from Docker container: ${detail}`));
            }
          });
          return;
        }
      });

      proc.on('error', (err: Error) => {
        settle(() => reject(aborted ? new Error(`Step ${key} aborted`) : err));
      });

      proc.on('exit', (code: number | null) => {
        settle(() => {
          reject(
            aborted
              ? new Error(`Step ${key} aborted`)
              : new Error(
                  `Docker container for step ${key} exited with code ${String(code)} before producing a result`,
                ),
          );
        });
      });

      // Send the work payload to the container's stdin
      const payload = JSON.stringify({ config, manifest: this.manifest }) + '\n';
      proc.stdin.write(payload);
      proc.stdin.end();
    });
  }

  /**
   * Force-remove a container (ignore errors if already removed).
   * @param containerId - Docker container ID to remove.
   */
  private async removeContainer(containerId: string): Promise<void> {
    try {
      await this.docker(['rm', '-f', containerId]);
    } catch {
      // Container may already be removed — safe to ignore.
    }
  }

  /**
   * Execute a Docker CLI command with an argv array (no shell interpolation).
   * @param args - Argument array for the `docker` command.
   * @returns stdout/stderr from the command.
   */
  private docker(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      execFile('docker', args, (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  }
}
