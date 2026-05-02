/**
 * Worker spawner for forked validation processes.
 *
 * Spawns each validator in a separate Node.js process with isolated memory.
 * When the process exits, ALL its memory is immediately reclaimed by the OS.
 * @packageDocumentation
 */

import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { WorkerConfig, WorkerInput, WorkerOutput, WorkerTool } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Default heap size per worker in MB */
const DEFAULT_HEAP_MB = 2048;

/** Default timeout per worker in ms (10 minutes) */
const DEFAULT_TIMEOUT_MS = 600_000;

/** TypeScript workers get more memory since they load the entire type graph (6 GB old-space). */
const TYPESCRIPT_HEAP_MB = 6144;

const NODE_OPTIONS_TOKEN_REGEX = /"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s]+/g;

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
 * Tokenizes NODE_OPTIONS while preserving quoted values with spaces.
 * @param value - Raw NODE_OPTIONS string.
 * @returns Ordered option tokens.
 */
function tokenizeNodeOptions(value: string): string[] {
  return value.match(NODE_OPTIONS_TOKEN_REGEX) ?? [];
}

/**
 * Merge an existing NODE_OPTIONS string with a required heap limit.
 *
 * Preserves unrelated Node flags and keeps the larger heap size when the
 * caller already requested one. This prevents validator wrappers from
 * accidentally downgrading the worker heap.
 * @param existingNodeOptions - Existing NODE_OPTIONS value, if any.
 * @param requiredHeapMB - Minimum heap size required by the worker.
 * @returns NODE_OPTIONS string with a max-old-space-size entry.
 */
export function mergeNodeOptions(existingNodeOptions: string | undefined, requiredHeapMB: number): string {
  const tokens = tokenizeNodeOptions((existingNodeOptions ?? '').trim());
  const remainingTokens: string[] = [];
  let highestHeapMB: number | undefined;

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];

    if (token.startsWith('--max-old-space-size=')) {
      const parsed = Number(token.slice('--max-old-space-size='.length));
      if (Number.isFinite(parsed)) {
        highestHeapMB = Math.max(highestHeapMB ?? 0, parsed);
      }
      continue;
    }

    if (token === '--max-old-space-size') {
      const parsed = Number(tokens[index + 1]);
      if (Number.isFinite(parsed)) {
        highestHeapMB = Math.max(highestHeapMB ?? 0, parsed);
        index++;
        continue;
      }
    }

    remainingTokens.push(token);
  }

  const resolvedHeapMB = highestHeapMB !== undefined && highestHeapMB > requiredHeapMB ? highestHeapMB : requiredHeapMB;

  return [...remainingTokens, `--max-old-space-size=${resolvedHeapMB}`].join(' ');
}

/**
 * Strip `--import` tokens from a NODE_OPTIONS string.
 *
 * Workers are spawned via `npx tsx` which registers its own ESM loader.
 * Inheriting `--import tsx/esm` (common in dev-server environments) causes
 * double-registration and intermittent worker failures.
 * @param nodeOptions - Raw NODE_OPTIONS string, may be undefined.
 * @returns Sanitized NODE_OPTIONS with `--import <value>` pairs removed.
 */
export function stripImportFlags(nodeOptions: string | undefined): string | undefined {
  if (!nodeOptions) return nodeOptions;
  const tokens = tokenizeNodeOptions(nodeOptions.trim());
  const filtered: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '--import') {
      i++; // skip the value token
      continue;
    }
    if (tokens[i].startsWith('--import=')) continue;
    filtered.push(tokens[i]);
  }
  const result = filtered.join(' ');
  return result || undefined;
}

/**
 * Resolves the worker script path for a given tool.
 * @param tool - The validation tool name
 * @returns Absolute path to the worker script
 */
function getWorkerPath(tool: WorkerTool): string {
  return path.join(__dirname, `${tool}.ts`);
}

/**
 * Spawns a validation worker process.
 *
 * The worker receives input via stdin (JSON) and sends output via stdout (JSON).
 * Stderr is inherited for verbose/debug logging. Each worker has its own V8 heap,
 * providing true memory isolation.
 * @param config - Worker configuration
 * @param input - Input data to send to the worker
 * @returns Promise resolving to worker output
 */
export async function spawnWorker(config: WorkerConfig, input: WorkerInput): Promise<WorkerOutput> {
  const { tool, timeoutMs = DEFAULT_TIMEOUT_MS } = config;
  const maxHeapMB = config.maxHeapMB ?? (tool === 'typescript' ? TYPESCRIPT_HEAP_MB : DEFAULT_HEAP_MB);

  const workerPath = getWorkerPath(tool);

  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', workerPath], {
      stdio: ['pipe', 'pipe', 'inherit'], // stdin for input, stdout for output, stderr inherited
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        NODE_OPTIONS: mergeNodeOptions(stripImportFlags(process.env['NODE_OPTIONS']), maxHeapMB),
      },
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

/**
 * Spawns multiple workers in parallel.
 *
 * Each worker runs in its own process with isolated memory. Results are
 * collected and returned once all workers complete.
 * @param configs - Array of worker configurations with their inputs
 * @returns Promise resolving to array of worker outputs (same order as configs)
 */
export async function spawnWorkersParallel(
  configs: Array<{ config: WorkerConfig; input: WorkerInput }>,
): Promise<WorkerOutput[]> {
  const promises = configs.map(({ config, input }) => spawnWorker(config, input));
  return Promise.all(promises);
}
