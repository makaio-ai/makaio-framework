/**
 * Shutdown stages of the Codex connector and the class each of them may claim.
 * @packageDocumentation
 */
import type { ConnectorTeardownResult } from '@makaio/contracts';
import {
  reportObservedExit,
  reportRepeatTeardown,
  stageFailure,
  withTimeout,
  type GenerationRetirementLedger,
} from '@makaio/ai-adapters-core';
import { describeTransportEnd, type IJsonlTransport, type TransportEnd } from '@makaio/subprocess';
import { APP_SERVER_PROCESS_NAME } from '../utils/createStdioTransport.js';

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

/**
 * Build the error that carries an end this connector asked for into its own
 * local finalisation.
 *
 * Such an end is deliberately kept out of the error channel — the connector
 * caused it, so it is not evidence of a fault — but the turn it interrupted
 * still has to be completed, its processing paused and its open tool calls
 * cleared. Those effects are reached through the error path, so the path needs
 * an error; this one names the requested shutdown as its cause rather than
 * pretending the child died unexpectedly. Like every end description it names
 * codes and signals only, never protocol content.
 * @param end - The end report, with cause `requested`
 * @returns Error describing the requested shutdown for local finalisation
 */
export function requestedShutdownError(end: TransportEnd): Error {
  return new Error(`${APP_SERVER_PROCESS_NAME} ${describeTransportEnd(end)}`);
}

/** Milliseconds a close waits for the provider to acknowledge thread archival. */
const ARCHIVE_TIMEOUT_MS = 2_000;

/**
 * Archive the active thread before the process is shut down.
 *
 * Bounded, because it is the one shutdown stage that waits on the provider: a
 * hung archive would hold the whole teardown, and a thread left unarchived is a
 * far smaller cost than a stop that never returns. A connector with no thread has
 * nothing to archive, and one whose client is already gone cannot ask.
 *
 * The bound comes from the shared `withTimeout` rather than a local race, because
 * a hand-rolled one had no way to clear its timer: on the far more common path
 * where the provider *does* acknowledge, the expiry timer stayed armed and kept
 * the event loop alive for the rest of the budget — in a shutdown path, which is
 * exactly where a process is trying to leave.
 * @param threadId - Active thread, when the connector has one.
 * @param requestArchive - Sends the archive request, or returns nothing without a client.
 * @throws Error when the provider does not acknowledge inside the archive budget.
 */
export async function archiveCodexThread(
  threadId: string | undefined,
  requestArchive: (threadId: string) => Promise<unknown> | undefined,
): Promise<void> {
  if (threadId === undefined) return;
  const archiveRequest = requestArchive(threadId);
  if (archiveRequest === undefined) return;
  await withTimeout(archiveRequest, ARCHIVE_TIMEOUT_MS, 'archive timeout');
}

interface CodexConnectionAbortOperations {
  /** Request the end of the connection: close the JSON-RPC client and the transport the connector holds. */
  readonly closeClient: () => void;
  /** Remove connector-local plaintext authentication. */
  readonly discardAuth: () => void;
  /** The connector's terminal teardown note, written when a stage here fails. */
  readonly note: CodexTerminalTeardownNote;
}

interface CodexConnectionCloseOperations extends CodexConnectionAbortOperations {
  /** Archive the active thread before process shutdown. */
  readonly archive: () => Promise<void>;
}

/**
 * Note left by the teardown that terminated a connector, when it failed.
 *
 * One per connector, written by the stages below and read by
 * {@link reportAfterCodexTermination}. The connector's termination marker records
 * that a teardown *ran*, which is what keeps a second one from repeating the work
 * — but on its own it cannot tell a delivered teardown from an attempted one, and
 * the two do not support the same class. Mutable rather than returned, because the
 * failing stages throw: they owe the caller the failure *and* the record, and only
 * one of those fits a return value.
 */
export interface CodexTerminalTeardownNote {
  /** Named stage of the terminal teardown that failed, once one has. */
  failure?: string;
}

/**
 * Abort the process while guaranteeing plaintext authentication is discarded.
 * @param operations - Connector-owned shutdown operations and failure note
 * @throws CodexConnectorCloseError When the JSON-RPC client close fails.
 */
export function abortCodexConnection(operations: CodexConnectionAbortOperations): void {
  try {
    operations.closeClient();
  } catch {
    const failure = new CodexConnectorCloseError('client-close-failed');
    operations.note.failure = stageFailure('panic abort', failure);
    throw failure;
  } finally {
    operations.discardAuth();
  }
}

/**
 * Attempt every graceful shutdown stage and preserve simultaneous failures.
 * @param operations - Connector-owned shutdown operations and failure note
 * @throws CodexConnectorCloseError When one stage failed, `AggregateError` when several did.
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
  if (failures.length === 0) return;

  operations.note.failure = stageFailure('graceful close', failures.map((failure) => failure.reason).join(', '));
  if (failures.length === 1) throw failures[0];
  throw new AggregateError(failures, 'Codex connector shutdown encountered multiple failures.');
}

/**
 * Report what a teardown arriving after termination may claim.
 *
 * A connector whose termination marker is already set has made no observation of
 * its own, and what it may say depends entirely on how the teardown that set the
 * marker ended. A clean one leaves {@link reportRepeatTeardown}'s `detached` — we
 * stopped holding the process and cannot say more. A **failed** one leaves
 * `unknown`: a teardown that could not deliver its own client close proved nothing
 * about the child, and inheriting its marker inherits that ignorance rather than
 * curing it.
 * @param note - Terminal teardown note the earlier teardown wrote.
 * @returns `unknown` naming the earlier failure, or the repeat report.
 */
export function reportAfterCodexTermination(note: CodexTerminalTeardownNote): ConnectorTeardownResult {
  if (note.failure === undefined) return reportRepeatTeardown();
  return {
    evidence: 'unknown',
    detail: `An earlier teardown of this connector failed and observed nothing: ${note.failure}.`,
  };
}

/**
 * Report the class a completed Codex shutdown may claim.
 *
 * The local evidence is the `codex app-server` process this connector spawned:
 * closing the JSON-RPC client closes the transport, which signals the child, and
 * the transport settles its own exit observation. Awaiting that observation
 * inside the exit budget is the difference between having asked for a
 * termination and having watched one. The observation is `exitObserved`, never
 * the end report: the report also arrives for a stop that gave up watching.
 *
 * The report is returned only once the transport's end report has been
 * delivered, which is a separate wait from the exit observation: the end report
 * follows the exit by the drain of the child's remaining stdout, and the
 * connector's local finalisation of a requested end (completing the turn the
 * shutdown interrupted) runs on that report. Returning on the exit alone would
 * let `close()` resolve while the interrupted message handle is still pending.
 * The finalisation reacts to the end report from a subscription made when the
 * generation was wired, ahead of this wait, so the report's reactions run in
 * that order and the finalisation has completed when this wait resumes. The wait
 * is unbounded here by design: `ended` fulfils exactly once and never rejects,
 * and the transport bounds every phase before it (kill grace, post-kill
 * observation, drain), an end it could not observe included. That bound holds
 * only for an end somebody requested, so the connector's close stage requests
 * the end of the transport it holds itself (`requestEnd` of the connection manager), whether or
 * not a client that would have done so exists; this function never waits for
 * an end the connector did not ask for.
 *
 * Two weaker answers, both honest. A connector holding no owned transport — a
 * harness that injected its client — never spawned a process, so no end of one
 * was ever observable. And a predecessor generation this connector superseded
 * without watching it end caps whatever this shutdown observed, because that
 * process may still be running and no later close will ever be able to say.
 * @param transport - Transport whose child this connector owned, when it owned one.
 * @param generations - Record of superseded generations nobody watched end.
 * @returns The class this shutdown may claim.
 */
export async function reportCodexShutdown(
  transport: IJsonlTransport | undefined,
  generations: GenerationRetirementLedger,
): Promise<ConnectorTeardownResult> {
  const observed: ConnectorTeardownResult =
    transport === undefined
      ? {
          evidence: 'detached',
          detail: 'This connector owned no app-server process, so no end of one was observable.',
        }
      : await reportObservedExit({ exited: transport.exitObserved, resource: 'The codex app-server process' });
  // The classification above is evidence; this is completion. See the paragraph on the end report.
  await transport?.ended;
  return generations.capReport(observed);
}
