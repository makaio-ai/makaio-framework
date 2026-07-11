/** Stable, credential-free connector shutdown failure categories. */
export type CodexConnectorCloseErrorReason = 'archive-failed' | 'client-close-failed';

/** Shutdown failure that never retains a protocol error or response payload. */
export class CodexConnectorCloseError extends Error {
  /**
   * @param reason - Stable shutdown stage safe for diagnostics
   */
  public constructor(public readonly reason: CodexConnectorCloseErrorReason) {
    super(reason === 'archive-failed' ? 'Codex thread archival failed.' : 'Codex app-server client close failed.');
    this.name = 'CodexConnectorCloseError';
  }
}

interface CodexConnectionAbortOperations {
  /** Close the active JSON-RPC client and its owned transport. */
  readonly closeClient: () => void;
  /** Remove connector-local plaintext authentication. */
  readonly discardAuth: () => void;
}

interface CodexConnectionCloseOperations extends CodexConnectionAbortOperations {
  /** Archive the active thread before process shutdown. */
  readonly archive: () => Promise<void>;
}

/**
 * Abort the process while guaranteeing plaintext authentication is discarded.
 * @param operations - Connector-owned shutdown operations
 */
export function abortCodexConnection(operations: CodexConnectionAbortOperations): void {
  try {
    operations.closeClient();
  } catch {
    throw new CodexConnectorCloseError('client-close-failed');
  } finally {
    operations.discardAuth();
  }
}

/**
 * Attempt every graceful shutdown stage and preserve simultaneous failures.
 * @param operations - Connector-owned shutdown operations
 */
export async function closeCodexConnection(operations: CodexConnectionCloseOperations): Promise<void> {
  const failures: CodexConnectorCloseError[] = [];
  try {
    try {
      await operations.archive();
    } catch {
      failures.push(new CodexConnectorCloseError('archive-failed'));
    }
    try {
      operations.closeClient();
    } catch {
      failures.push(new CodexConnectorCloseError('client-close-failed'));
    }
  } finally {
    operations.discardAuth();
  }

  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Codex connector shutdown encountered multiple failures.');
  }
}
