/**
 * Worker spawner for forked validation processes.
 *
 * Spawns each validator in a separate process with isolated memory.
 * When the process exits, ALL its memory is immediately reclaimed by the OS.
 * @packageDocumentation
 */

import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { WorkerConfig, WorkerInput, WorkerOutput, WorkerTool } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Default timeout per worker in ms (10 minutes) */
const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * Resolves the process id target used for worker cancellation.
 * @param pid - Worker wrapper process id.
 * @param platform - Process platform.
 * @returns PID target for process.kill.
 */
export function getWorkerKillTarget(pid: number, platform: NodeJS.Platform = process.platform): number {
  return platform === 'win32' ? pid : -pid;
}

/**
 * Terminates a worker and its descendants when the platform supports process groups.
 * @param child - Spawned worker wrapper process.
 */
function killWorker(child: ChildProcess): void {
  if (child.pid === undefined) {
    child.kill('SIGKILL');
    return;
  }

  try {
    process.kill(getWorkerKillTarget(child.pid), 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

/**
 * Resolves the worker script path for a given tool.
 * @param tool - The validation tool name
 * @returns Absolute path to the worker script
 */
function getWorkerPath(tool: WorkerTool): string {
  return path.join(__dirname, `${tool}.ts`);
}

/** ESLint's CJS plugin/config resolution is slower under Bun than Node+tsx. */
const TOOLS_REQUIRING_NODE: ReadonlySet<WorkerTool> = new Set(['eslint']);

/**
 * Resolves the local tsx binary from the project's node_modules.
 * @returns Absolute path to the tsx executable
 */
function resolveLocalTsx(): string {
  return path.join(process.cwd(), 'node_modules', '.bin', 'tsx');
}

/**
 * Resolves the spawn command and arguments for a worker tool.
 * @param tool - The validation tool to spawn
 * @param workerPath - Absolute path to the worker script
 * @returns Tuple of command and arguments
 */
export function getWorkerCommand(tool: WorkerTool, workerPath: string): [cmd: string, args: string[]] {
  if (TOOLS_REQUIRING_NODE.has(tool)) {
    return [resolveLocalTsx(), [workerPath]];
  }
  return ['bun', [workerPath]];
}

/**
 * Spawns a validation worker process.
 *
 * The worker receives input via stdin (JSON) and sends output via stdout (JSON).
 * Stderr is inherited for verbose/debug logging.
 * @param config - Worker configuration
 * @param input - Input data to send to the worker
 * @returns Promise resolving to worker output
 */
export async function spawnWorker(config: WorkerConfig, input: WorkerInput): Promise<WorkerOutput> {
  const { tool, timeoutMs = DEFAULT_TIMEOUT_MS } = config;
  const workerPath = getWorkerPath(tool);

  const [cmd, args] = getWorkerCommand(tool, workerPath);

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'inherit'],
      detached: process.platform !== 'win32',
      cwd: process.cwd(),
    });

    let stdout = '';
    let timedOut = false;

    // Set timeout
    const timer = setTimeout(() => {
      timedOut = true;
      killWorker(child);
    }, timeoutMs);

    // Collect stdout
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    // Handle process exit
    child.on('close', (code, signal) => {
      clearTimeout(timer);

      if (timedOut) {
        resolve({
          success: false,
          results: {},
          status: { tool, status: 'failed', error: `Worker timed out after ${timeoutMs}ms` },
          error: `Worker timed out after ${timeoutMs}ms`,
        });
        return;
      }

      if (signal === 'SIGKILL' || code === 137) {
        // OOM killed
        resolve({
          success: false,
          results: {},
          status: { tool, status: 'failed', error: 'Worker killed (likely OOM)' },
          error: 'Worker killed (likely OOM)',
        });
        return;
      }

      if (code !== 0) {
        resolve({
          success: false,
          results: {},
          status: { tool, status: 'failed', error: `Worker exited with code ${code}` },
          error: stdout || `Worker exited with code ${code}`,
        });
        return;
      }

      // Parse JSON output
      try {
        const output = JSON.parse(stdout) as WorkerOutput;
        resolve(output);
      } catch {
        resolve({
          success: false,
          results: {},
          status: { tool, status: 'failed', error: 'Failed to parse worker output' },
          error: `Failed to parse worker output: ${stdout.slice(0, 500)}`,
        });
      }
    });

    // Handle spawn errors
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn ${tool} worker: ${err.message}`));
    });

    // Send input and close stdin
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}
