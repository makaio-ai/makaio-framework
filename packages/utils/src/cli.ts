/** Exit codes shared by framework CLI commands. */
export const CLI_EXIT_CODES = {
  /** Generic command failure. */
  failure: 1,
  /** GNU `timeout` convention. */
  timeout: 124,
  /** Shell Ctrl-C convention. */
  abort: 130,
} as const;

/** Known command error categories that map to stable CLI exit codes. */
export type CliCommandErrorKind = 'abort' | 'timeout' | 'failure';

/**
 * Read all stdin bytes when input is piped into the process.
 * @returns The stdin content, or `null` when stdin is attached to a TTY.
 */
export async function readStdin(): Promise<string | null> {
  if (process.stdin.isTTY) {
    return null;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
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
