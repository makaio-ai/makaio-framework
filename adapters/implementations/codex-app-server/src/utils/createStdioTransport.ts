import * as path from 'node:path';
import { CONNECTOR_EXIT_OBSERVATION_MS } from '@makaio/ai-adapters-core';
import { createJsonlTransport, type IJsonlTransport, type ProcessStopTiming } from '@makaio/subprocess';

/** Name of the app-server child in logs and in every description of its end. */
export const APP_SERVER_PROCESS_NAME = 'codex app-server';

/**
 * Bounded phases of stopping a `codex app-server` child: the time between
 * `SIGTERM` and `SIGKILL`, the time the exit is awaited after `SIGKILL`, and the
 * time stdout is drained after the exit.
 */
export type AppServerStopTiming = Required<ProcessStopTiming>;

/**
 * Stop timing of one app-server generation, carved out of the connector's
 * budget for observing an end ({@link CONNECTOR_EXIT_OBSERVATION_MS}) so that a
 * stop is observed, and its end reported, inside it: half for the graceful
 * `SIGTERM` stage, a fifth for observing the exit after `SIGKILL`, a fifth for
 * draining stdout after the exit, and the last tenth as margin for delivering
 * the events. The transport package keeps its own, longer defaults; these are
 * the app-server's, and {@link createStdioTransport} uses them unless a caller
 * passes its own.
 */
export const APP_SERVER_STOP_TIMING: AppServerStopTiming = {
  killGraceMs: CONNECTOR_EXIT_OBSERVATION_MS / 2,
  exitObservationMs: CONNECTOR_EXIT_OBSERVATION_MS / 5,
  drainTimeoutMs: CONNECTOR_EXIT_OBSERVATION_MS / 5,
};

/** Inputs of {@link createStdioTransport}. */
export interface CodexStdioTransportOptions {
  /** Working directory of the app-server. */
  readonly cwd: string;
  /**
   * The child's complete environment. It replaces the host environment rather
   * than extending it, so nothing ambient (such as authentication) is inherited;
   * undefined values are dropped.
   */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Absolute path to the codex binary; when omitted, `codex` is resolved from the `PATH` in {@link env}. */
  readonly binaryPath?: string;
  /** Bounded phases of a stop. Defaults to {@link APP_SERVER_STOP_TIMING}, which fits the connector's budget. */
  readonly timing?: AppServerStopTiming;
}

/**
 * Resolve the command used to start the Codex app server.
 * @param binaryPath - Optional resolved managed binary path.
 * @returns Absolute managed binary path, or the PATH-resolved `codex` command.
 */
function resolveSpawnCommand(binaryPath: string | undefined): string {
  if (binaryPath === undefined) {
    return 'codex';
  }

  if (binaryPath.trim() === '' || !path.isAbsolute(binaryPath)) {
    throw new Error('binaryPath must be a non-empty absolute path when provided');
  }

  return binaryPath;
}

/**
 * Start `codex app-server` on the shared JSONL transport, which owns the child,
 * its pipes and the one report of how it ended.
 *
 * The options are the app-server's protocol and trust boundary:
 *
 * - **stdout is the channel** (`onStdoutEnd: 'terminal'`): app-server is a
 *   long-lived server, so stdout ending without an exit is a lost connection, and
 *   every end nobody asked for — a clean exit included — reaches the error channel.
 *   An unterminated final line is parsed at the genuine end of stdout
 *   (`finalLine: 'parse'`) and handed to the JSON-RPC client, which ignores
 *   anything that is not an object.
 * - **A throwing message consumer is a transport failure**
 *   (`listenerErrors: 'fail'`): it is a connector fault that would otherwise
 *   leave a request unanswered, so it ends the channel and stops the child.
 * - **Credential-safe diagnostics**: the environment is replaced, never merged
 *   with the host's; stderr is suppressed with one content-free warning, because
 *   Codex may include an account-login payload in its debug output; malformed
 *   lines and ends are described by counts, codes and signals only.
 * - **Direct child** (`terminateTree: false`): a stop signals the app-server
 *   itself, which stays in the host's process group.
 *
 * Validate `binaryPath` here as well as at the bus contract boundary, because
 * this utility is exported and may be called directly by tests or other hosts.
 * @param options - Working directory, environment, binary and stop timing.
 * @returns The transport to the child.
 * @throws Error when `binaryPath` is given but is not a non-empty absolute path.
 * @example
 * ```ts
 * const transport = createStdioTransport({ cwd: '/path/to/project', env: { PATH: '/usr/bin' } });
 * transport.onMessage((message) => console.log('Received:', message));
 * transport.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
 * ```
 */
export function createStdioTransport(options: CodexStdioTransportOptions): IJsonlTransport {
  return createJsonlTransport({
    command: resolveSpawnCommand(options.binaryPath),
    args: ['app-server'],
    cwd: options.cwd,
    env: options.env,
    processName: APP_SERVER_PROCESS_NAME,
    envMode: 'replace',
    stderr: 'suppress',
    listenerErrors: 'fail',
    onStdoutEnd: 'terminal',
    finalLine: 'parse',
    terminateTree: false,
    ...(options.timing ?? APP_SERVER_STOP_TIMING),
  });
}
