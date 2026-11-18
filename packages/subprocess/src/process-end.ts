/**
 * The end model of a spawned child process.
 *
 * How a child ended is never one fact. A transport records three facts
 * separately, each at most once and never changed afterwards:
 *
 * - the **process exit**: how the child itself ended, or that its end could not
 *   be observed;
 * - the **stop intent**: whether, and in which order relative to the other facts,
 *   the owner asked for the end;
 * - the **communication outcome**: whether stdout was read to its end and stdin
 *   stayed writable.
 *
 * stdout reaching its end proves no exit, a `close()` proves no cause, and an
 * exit proves no complete delivery. The {@link EndCause} is therefore derived
 * from the order of the facts ({@link deriveEndCause}), never stored beside them.
 * What an end *means* (a crash, a finished job, a lost connection) stays with
 * each consumer.
 */

/** Exit of a child whose end was observed: it ran and exited, or it never started. */
export type ObservedProcessExit =
  | {
      readonly kind: 'exited';
      /** Exit code, `null` when the child was ended by a signal. */
      readonly code: number | null;
      /** Terminating signal, `null` when the child exited with a code. */
      readonly signal: NodeJS.Signals | null;
    }
  | {
      readonly kind: 'spawn-failed';
      /** Error the spawn attempt reported; it may name the command, never its environment. */
      readonly error: Error;
    };

/**
 * Why the end of a child could not be observed within its bounded stop.
 * `signal-denied`: a termination signal could not be delivered.
 * `observation-timeout`: signals were delivered, but no exit arrived in time.
 */
export type UnobservedExitReason = 'signal-denied' | 'observation-timeout';

/**
 * How a child ended, as far as its owner could tell.
 *
 * `unobserved` is not an exit: the child may still run. A later real exit is a
 * separate observation and never rewrites this fact.
 */
export type ProcessExit =
  | ObservedProcessExit
  | {
      readonly kind: 'unobserved';
      readonly reason: UnobservedExitReason;
    };

/**
 * A failure of the channel to the child, independent of how the child ended.
 * `stdin-failed`: a write to stdin failed (for example `EPIPE`). Only a Node
 * host reports this: under Bun a write to a pipe whose reader closed reports
 * success and the stream emits no error, so a child that closed its stdin but
 * keeps running is not detected there; its channel then ends with its exit, its
 * stdout end (under a `terminal` policy) or `close()`.
 * `stdout-failed`: the stdout stream reported an error.
 * `stdout-ended`: stdout of a channel whose end is terminal reached its end and
 * the child did not exit within the drain deadline.
 * `listener-failed`: a message listener threw while its owner treats a failing
 * consumer as a failed channel.
 */
export type CommunicationFailure =
  | { readonly kind: 'stdin-failed'; readonly error: Error }
  | { readonly kind: 'stdout-failed'; readonly error: Error }
  | { readonly kind: 'stdout-ended' }
  | { readonly kind: 'listener-failed'; readonly error: Error };

/**
 * How far stdout was delivered, and whether the drain closed every pipe, before
 * the end was reported. Every variant counts the characters that were dropped
 * instead of delivered; the characters themselves are never kept, since
 * protocol payloads may carry credentials.
 * `complete`: stdout reached its genuine end and nothing cut the drain short;
 * `discardedChars` counts an unterminated final line dropped under the `discard`
 * {@link FinalLinePolicy}. A child that never started has nothing to drain and
 * reports `complete`.
 * `timed-out`: the drain deadline expired while a pipe was still held open, by
 * the child's descendants or by a stalled pipe. `stdoutComplete` says whether
 * stdout itself had reached its end first (then only stderr was held and every
 * message was delivered); otherwise the undelivered rest of stdout was dropped.
 * `failed`: stdout reported an error; the undelivered rest was dropped.
 * `abandoned`: the exit was not observed, so no drain window opened; the pipes
 * were released at once and the undelivered rest of stdout was dropped.
 */
export type DrainOutcome =
  | { readonly kind: 'complete'; readonly discardedChars: number }
  | { readonly kind: 'timed-out'; readonly discardedChars: number; readonly stdoutComplete: boolean }
  | { readonly kind: 'failed'; readonly discardedChars: number }
  | { readonly kind: 'abandoned'; readonly discardedChars: number };

/**
 * Why a transport ended.
 * `requested`: the stop intent came before the first terminal fact.
 * `unexpected`: the child exited, or the channel failed, before any stop intent.
 * `spawn-failed`: the child never started and no stop intent came first.
 */
export type EndCause = 'requested' | 'unexpected' | 'spawn-failed';

/**
 * Why quiescence of an owned process group stayed unproven.
 * `poll-timeout`: members were still present when the bounded proof gave up, or
 *   (Windows) the tree termination had not finished when the end was reported.
 * `ps-unavailable`: the host has no process listing to prove quiescence with.
 * `signal-error`: a group probe failed with an unexpected error, or (Windows)
 *   the tree termination was refused.
 * `no-termination`: (Windows) no tree termination reached the tree: the end came
 *   without a stop (a crash), or `taskkill` found no process to end. Windows has
 *   no process group to probe, so nothing else could prove quiescence.
 *
 * TODO(FACT-463): Windows Job Objects would make the tree addressable and
 * provable, and retire `no-termination`.
 */
export type TreeQuiescenceGap = 'poll-timeout' | 'ps-unavailable' | 'signal-error' | 'no-termination';

/**
 * Evidence about the processes a child started, kept apart from the child's own
 * {@link ProcessExit}: a child that exited may leave descendants running.
 *
 * On POSIX the evidence covers the child's process group, which is what the
 * owner can address. A descendant that left the group (through `setsid` or
 * `setpgid`, a daemonising tool, or a nested owner that isolates its own child
 * in a group of its own) is neither stopped with the group nor counted here.
 * `not-owned`: the owner was responsible for the direct child only.
 * `quiescent`: no live member of the child's process group is left (Windows: a
 *   `taskkill` of the whole tree succeeded).
 * `unproven`: members may still run; `reason` says why no proof exists. Only a
 *   positive proof counts as quiescent, never the absence of evidence.
 */
export type ProcessTreeEvidence =
  | { readonly kind: 'not-owned' }
  | { readonly kind: 'quiescent' }
  | { readonly kind: 'unproven'; readonly reason: TreeQuiescenceGap };

/** Everything a transport reports, exactly once, when it has ended. */
export interface TransportEnd {
  /** Cause derived from the order of the facts (see {@link deriveEndCause}). */
  readonly cause: EndCause;
  /** How the child ended, or that its end was not observed. */
  readonly exit: ProcessExit;
  /** How far stdout was delivered before this report. */
  readonly drain: DrainOutcome;
  /** First failure of the channel, if any; independent of {@link exit}. */
  readonly communicationFailure: CommunicationFailure | undefined;
  /** Evidence about the child's descendants; independent of {@link exit}. */
  readonly tree: ProcessTreeEvidence;
}

/**
 * What a channel's consumer makes of stdout reaching its end while the child
 * has not exited.
 * `terminal`: stdout is the channel; its end ends the transport.
 * `ignore`: stdout carries no lasting protocol; the child stays supervised until
 * it exits or is stopped.
 */
export type StdoutEndPolicy = 'terminal' | 'ignore';

/**
 * What a decoder does with a final line that ends without a newline when its
 * input reaches its end.
 * `parse`: decode it like any other line.
 * `discard`: drop it and count its characters.
 */
export type FinalLinePolicy = 'parse' | 'discard';

/**
 * One fact as a transport recorded it. A transport records the facts in the
 * order it observed them; each kind is meaningful only at its first occurrence.
 */
export type EndFact =
  | { readonly kind: 'stop-requested' }
  | { readonly kind: 'process-ended'; readonly exit: ProcessExit }
  | { readonly kind: 'communication-failed'; readonly failure: CommunicationFailure };

/**
 * Derive why a transport ended from the facts it recorded, in observation order.
 *
 * The end was `requested` when the stop intent was recorded before the first
 * process end or communication failure. Anything else was not requested: it is
 * `spawn-failed` when the child never started, and `unexpected` otherwise. A
 * stop intent recorded after the first terminal fact (a `close()` issued while
 * an unexpected end is being delivered) changes nothing.
 * @param facts - Facts in the order they were observed.
 * @returns The cause the facts determine.
 */
export function deriveEndCause(facts: readonly EndFact[]): EndCause {
  const firstTerminal = facts.findIndex((fact) => fact.kind !== 'stop-requested');
  const stopIntent = facts.findIndex((fact) => fact.kind === 'stop-requested');
  if (stopIntent !== -1 && (firstTerminal === -1 || stopIntent < firstTerminal)) {
    return 'requested';
  }
  const processEnd = facts.find((fact) => fact.kind === 'process-ended');
  return processEnd?.exit.kind === 'spawn-failed' ? 'spawn-failed' : 'unexpected';
}

/**
 * Name an error without its message: a message may carry a command line or
 * protocol content, while an errno code or error name cannot.
 * @param error - Error to name.
 * @returns The errno code when present, otherwise the error name.
 */
export function errorLabel(error: Error): string {
  return 'code' in error && typeof error.code === 'string' ? error.code : error.name;
}

/**
 * Describe how a child ended, without any content that could carry credentials.
 * @param exit - Process exit to describe.
 * @returns A phrase such as `exited with code 1` or `could not be spawned (ENOENT)`.
 */
export function describeProcessExit(exit: ProcessExit): string {
  switch (exit.kind) {
    case 'exited':
      if (exit.code !== null) return `exited with code ${exit.code}`;
      return exit.signal !== null ? `exited with signal ${exit.signal}` : 'exited without a code or signal';
    case 'spawn-failed':
      return `could not be spawned (${errorLabel(exit.error)})`;
    case 'unobserved':
      return `exit not observed (${exit.reason})`;
  }
}

/**
 * Describe a channel failure without any content that could carry credentials.
 * @param failure - Communication failure to describe.
 * @returns A phrase naming the failed stream.
 */
function describeCommunicationFailure(failure: CommunicationFailure): string {
  switch (failure.kind) {
    case 'stdin-failed':
      return `stdin write failed (${errorLabel(failure.error)})`;
    case 'stdout-failed':
      return `stdout failed (${errorLabel(failure.error)})`;
    case 'stdout-ended':
      return 'stdout ended without an exit';
    case 'listener-failed':
      return `message listener failed (${errorLabel(failure.error)})`;
  }
}

/**
 * Describe how far stdout was delivered.
 * @param drain - Drain outcome to describe.
 * @returns A phrase, or `undefined` for a complete drain that dropped nothing.
 */
function describeDrain(drain: DrainOutcome): string | undefined {
  switch (drain.kind) {
    case 'complete':
      return drain.discardedChars > 0
        ? `unterminated final stdout line discarded (${drain.discardedChars} chars)`
        : undefined;
    case 'timed-out':
      return drain.stdoutComplete
        ? 'stderr held open past the drain deadline'
        : `stdout truncated at the drain deadline (${drain.discardedChars} chars discarded)`;
    case 'failed':
      return `stdout drain failed (${drain.discardedChars} chars discarded)`;
    case 'abandoned':
      return `stdout abandoned without a drain (${drain.discardedChars} chars discarded)`;
  }
}

/**
 * Describe the evidence about a child's descendants. Like a complete drain, a
 * quiescent group is the unremarkable case and goes unmentioned.
 * @param tree - Tree evidence to describe.
 * @returns A phrase when members may have outlived the child, otherwise `undefined`.
 */
function describeTree(tree: ProcessTreeEvidence): string | undefined {
  if (tree.kind !== 'unproven') return undefined;
  return `process group quiescence unproven (${tree.reason})`;
}

/**
 * Report whether a process of an ended child may still be running: its exit was
 * not observed (the child itself may run on), a pipe was held past the drain
 * deadline (its holder is alive), or its owned process group was not proven
 * quiescent (members may run on). Only a positive proof counts as safe: on
 * Windows, an owned tree that no `taskkill` reached (for example after a crash)
 * is unproven and therefore possibly alive. A child whose descendants are not
 * owned (`not-owned`) rests on the exit and the drain alone.
 * @param end - End report of the child.
 * @returns `true` when the end leaves a process of the child possibly alive.
 */
export function mayHaveLeftProcesses(end: TransportEnd): boolean {
  if (end.exit.kind === 'unobserved' || end.drain.kind === 'timed-out') return true;
  return end.tree.kind === 'unproven';
}

const CAUSE_PHRASES: Readonly<Record<EndCause, string>> = {
  requested: 'stopped on request',
  unexpected: 'ended unexpectedly',
  'spawn-failed': 'failed to start',
};

/**
 * Describe a transport end for logs and error messages. The description names
 * facts only (codes, signals, errno codes, counts) and never includes an error
 * message, a command line, an environment value or stdout content.
 * @param end - Transport end to describe.
 * @returns A single-line description such as `ended unexpectedly: exited with code 1`.
 */
export function describeTransportEnd(end: TransportEnd): string {
  const details = [
    describeProcessExit(end.exit),
    end.communicationFailure === undefined ? undefined : describeCommunicationFailure(end.communicationFailure),
    describeDrain(end.drain),
    describeTree(end.tree),
  ].filter((detail): detail is string => detail !== undefined);
  return `${CAUSE_PHRASES[end.cause]}: ${details.join('; ')}`;
}
