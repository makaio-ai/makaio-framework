/** Exit codes shared by framework CLI commands. */
export const CLI_EXIT_CODES = {
  /** Generic command failure. */
  failure: 1,
  /** GNU `timeout` convention. */
  timeout: 124,
  /** Shell Ctrl-C convention. */
  abort: 130,
} as const;

/** Process signals that should abort a local CLI command cooperatively. */
export const CLI_COMMAND_ABORT_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/** Signal-specific shell exit codes for cooperative CLI command shutdown. */
export const CLI_COMMAND_SIGNAL_EXIT_CODES: Record<(typeof CLI_COMMAND_ABORT_SIGNALS)[number], number> = {
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129,
};

/** Known command error categories that map to stable CLI exit codes. */
export type CliCommandErrorKind = 'abort' | 'timeout' | 'failure';

/**
 * Read all stdin bytes when input is piped into the process.
 * @param signal - Optional command abort signal that cancels the stdin read.
 * @returns The stdin content, or `null` when stdin is attached to a TTY.
 */
export async function readStdin(signal?: AbortSignal): Promise<string | null> {
  if (process.stdin.isTTY) {
    return null;
  }
  if (signal?.aborted === true) {
    throw createCliAbortError(signal.reason);
  }

  const chunks: Buffer[] = [];
  const stdin = process.stdin;
  const readPromise = (async (): Promise<string> => {
    for await (const chunk of stdin) {
      if (typeof chunk === 'string') {
        chunks.push(Buffer.from(chunk));
      } else {
        chunks.push(Buffer.from(chunk as Uint8Array));
      }
    }
    return Buffer.concat(chunks).toString('utf-8');
  })();
  readPromise.catch(() => undefined);

  if (signal === undefined) {
    return await readPromise;
  }

  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    onAbort = (): void => {
      const error = createCliAbortError(signal.reason);
      stdin.destroy(error);
      reject(error);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

  try {
    return await Promise.race([readPromise, abortPromise]);
  } finally {
    if (onAbort !== undefined) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

/**
 * Classify bus wait errors for user-facing CLI handling.
 *
 * Uses the stable error `name` instead of importing bus-core error classes so
 * this package remains a zero-internal-dependency utility layer.
 * @param error - Caught command error.
 * @returns The CLI error category.
 */
export function classifyCliCommandError(error: unknown): CliCommandErrorKind {
  if (error instanceof Error && error.name === 'OnceAbortError') {
    return 'abort';
  }
  if (error instanceof Error && error.name === 'OnceTimeoutError') {
    return 'timeout';
  }
  return 'failure';
}

/**
 * Resolve a process-signal abort reason to its conventional CLI exit code.
 * @param reason - AbortSignal reason captured from the process signal handler.
 * @returns Signal-specific exit code, or `undefined` when the reason is not a known command signal.
 */
export function resolveCliSignalExitCode(reason: unknown): number | undefined {
  return typeof reason === 'string' && Object.hasOwn(CLI_COMMAND_SIGNAL_EXIT_CODES, reason)
    ? CLI_COMMAND_SIGNAL_EXIT_CODES[reason as keyof typeof CLI_COMMAND_SIGNAL_EXIT_CODES]
    : undefined;
}

/**
 * Build the abort error shape used by bus-aware CLI handlers.
 * @param reason - Abort reason captured from the command signal.
 * @returns Error classified as a command abort by {@link classifyCliCommandError}.
 */
function createCliAbortError(reason: unknown): Error {
  const message = reason === undefined ? 'Command aborted' : String(reason);
  const error = new Error(message);
  error.name = 'OnceAbortError';
  return error;
}
