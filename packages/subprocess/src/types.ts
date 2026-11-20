import type { FinalLinePolicy, ObservedProcessExit, StdoutEndPolicy, TransportEnd } from './process-end.js';
import type { ProcessSignalPort } from './process-tree.js';
import type { StopHost } from './stop-escalation.js';

/**
 * Options for spawning a subprocess.
 * @param command - Executable command (absolute path or PATH-resolved name).
 * @param args - Command-line arguments.
 * @param cwd - Working directory.
 * @param env - Environment variables (undefined values are filtered out). A launch that merges the host
 *   environment lets `undefined` remove an inherited entry; on Windows names match case-insensitively there.
 * @param processName - Human-readable label for diagnostics and error messages.
 */
export interface SubprocessSpawnOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly processName?: string;
}

/**
 * How the `env` of {@link SubprocessSpawnOptions} becomes the child's environment.
 * `merge`: the host environment, overridden by `env`; an `undefined` value removes the inherited entry
 * (on Windows, whatever its letter case).
 * `replace`: `env` alone; nothing of the host environment is inherited.
 */
export type SpawnEnvMode = 'merge' | 'replace';

/**
 * What a transport does with the child's stderr.
 * `log`: forward every chunk to the host log.
 * `suppress`: drop the content and log once that output was suppressed, for
 * children whose diagnostics may carry credentials.
 */
export type StderrMode = 'log' | 'suppress';

/**
 * What a transport makes of a message listener that throws.
 * `isolate`: log it; later listeners and the channel are unaffected.
 * `fail`: treat it as a failed channel (`listener-failed`), which ends the
 * transport like any other communication failure.
 */
export type ListenerErrorPolicy = 'isolate' | 'fail';

/**
 * How long each bounded phase of a child's end may take. Every owner of a
 * JSONL child (the transport itself, the process lifecycle, the stdio server
 * transport) takes the same timing, so a caller's budget reaches the
 * transport unchanged. Omitted fields take the transport's defaults.
 */
export interface ProcessStopTiming {
  /**
   * Longest time, in milliseconds, stdout and stderr are drained after the
   * exit is observed, and longest time a `terminal` channel waits for the exit
   * after stdout ended. A `close()` deadline shortens it. Defaults to 5000.
   */
  readonly drainTimeoutMs?: number;
  /** Time, in milliseconds, between `SIGTERM` and `SIGKILL` on POSIX hosts. Defaults to 5000. */
  readonly killGraceMs?: number;
  /** Time, in milliseconds, the exit is awaited after the forceful stage before it counts as unobserved. Defaults to 2000. */
  readonly exitObservationMs?: number;
}

/**
 * Options of a JSONL transport: how the child is spawned, what its consumer
 * makes of the channel, and how long each bounded phase of its end may take.
 */
export interface JsonlTransportOptions extends SubprocessSpawnOptions, ProcessStopTiming {
  /** What stdout reaching its end means while the child has not exited; no default, every consumer decides. */
  readonly onStdoutEnd: StdoutEndPolicy;
  /** Whether an unterminated final stdout line is parsed at the genuine stdout end. Defaults to `discard`. */
  readonly finalLine?: FinalLinePolicy;
  /**
   * Whether the owner takes the processes the child starts into its stop,
   * instead of the child alone. Defaults to `true`. On POSIX the child leads an
   * isolated process group: a stop signals the whole group while the child's
   * exit is unobserved, and every end reports whether the group went quiet
   * (`TransportEnd.tree`). Members that outlive the child's observed exit are
   * not signalled again (see `stop-escalation.ts`), and processes that left the
   * group are not reached at all. On Windows a stop ends the process tree
   * forcefully. See the module documentation of `process-tree.ts` for the side
   * effects of a process group: the child no longer receives the terminal's
   * signals and must exit by itself when the host goes away.
   */
  readonly terminateTree?: boolean;
  /** How `env` becomes the child's environment. Defaults to `merge`. */
  readonly envMode?: SpawnEnvMode;
  /** What happens to stderr output. Defaults to `log`. */
  readonly stderr?: StderrMode;
  /** What a throwing message listener means. Defaults to `isolate`. */
  readonly listenerErrors?: ListenerErrorPolicy;
  /** Longest accepted stdout line in UTF-16 code units; see `createJsonlDecoder`. */
  readonly maxLineLength?: number;
  /**
   * POSIX signal primitive used for stop signals and the quiescence proof.
   * Defaults to the host's `process.kill`. A Windows tree stop runs `taskkill`
   * and does not use it.
   */
  readonly signalPort?: ProcessSignalPort;
  /**
   * The host facts a stop depends on: the platform that selects its stages and
   * the forceful termination of a Windows process tree. Defaults to the real
   * host. A seam for tests that drive the Windows tree stop against a real child
   * on a POSIX host, like {@link JsonlTransportOptions.signalPort} drives
   * denied signals; production code passes none.
   * @internal
   */
  readonly stopHost?: StopHost;
}

/** Options of one {@link IJsonlTransport.close} call. */
export interface TransportCloseOptions {
  /**
   * Time by which the caller needs the end report, in epoch milliseconds
   * (`Date.now()` clock). It shortens the kill grace, the exit observation and
   * the drain; it never extends them. The earliest deadline of all calls wins.
   */
  readonly deadline?: number;
}

/**
 * Synchronous state of a transport.
 * `writable`: `send()` writes to the child's stdin.
 * `ending`: writing is blocked (stop intent, observed exit or failed channel)
 *   and the end has not been reported yet.
 * `ended`: {@link IJsonlTransport.ended} has fulfilled.
 */
export type TransportStatus = 'writable' | 'ending' | 'ended';

/** Listener invoked when a parsed JSON message arrives from stdout. */
export type MessageListener = (message: unknown) => void;

/**
 * JSONL-framed subprocess transport, and the one owner of its child process.
 *
 * Sends JSON objects as newline-delimited lines to stdin, receives them from
 * stdout. Supports multiple concurrent listeners.
 *
 * The transport records three facts, each at most once: how the child ended,
 * whether and when a stop was requested, and how the channel ended. It derives
 * the cause of its end from their order and reports the end exactly once,
 * through {@link ended}, after the last stdout message was delivered. What an
 * end means (a terminal error, a finished job, a requested stop) is decided by
 * each consumer from that report.
 *
 * stdout is decoded as UTF-8 across chunk boundaries. A line that is not valid
 * JSON or exceeds the maximum line length, and an unterminated final line under
 * the `discard` policy, carry no readable correlation and leave the process
 * running, so the transport drops them and logs a count that never includes
 * the line itself.
 */
export interface IJsonlTransport {
  /**
   * Send a JSON-serializable message to stdin; throws synchronously unless
   * {@link status} is `writable`. A write that fails later (`EPIPE`) fails the
   * channel as `stdin-failed`; a Bun host does not report such a failure (see
   * `CommunicationFailure`).
   */
  send(message: object): void;
  /**
   * Request the end: record the stop intent, block writing, and stop the child
   * (and its tree, when owned) while its exit is unobserved, escalating from
   * `SIGTERM` to `SIGKILL` on POSIX. Every phase is bounded; a child whose exit
   * is not observed in time ends as `unobserved`. Idempotent; a later call with
   * an earlier deadline still shortens whatever has not finished, up to the
   * end report.
   * @param options - Deadline for the end report.
   * @returns {@link ended}.
   */
  close(options?: TransportCloseOptions): Promise<TransportEnd>;
  /** Register a message listener. Returns an unsubscribe function. */
  onMessage(listener: MessageListener): () => void;
  /**
   * The end report. Fulfils exactly once, for every cause, after the last
   * stdout message was delivered; never rejects; later reads replay it.
   */
  readonly ended: Promise<TransportEnd>;
  /**
   * The child's observed exit. Fulfils only when an exit or a failed spawn was
   * actually observed, also after the end reported `unobserved`; it stays
   * pending for a child whose exit is never seen. Never rejects.
   */
  readonly exitObserved: Promise<ObservedProcessExit>;
  /** Current synchronous state. */
  readonly status: TransportStatus;
}

/**
 * The part of a JSONL transport a message-level client such as the JSON-RPC
 * client drives: writing, closing, reading, and the end report that settles
 * whatever the client still has outstanding.
 */
export type JsonlChannel = Pick<IJsonlTransport, 'send' | 'close' | 'onMessage' | 'ended'>;
