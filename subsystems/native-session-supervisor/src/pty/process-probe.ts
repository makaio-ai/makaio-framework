/**
 * Local process-existence probe.
 *
 * `process.kill(pid, 0)` sends no signal; it only asks the kernel whether the
 * PID can be signalled. That makes it the cheapest observation available about a
 * process this runtime caused to exist — and its outcomes are deliberately kept
 * apart, because only one of them proves anything a caller may act on.
 *
 * **PID recycling is the reason the outcomes are asymmetric.** A recycled PID
 * can make a *dead* process look alive; it can never make a *live* process look
 * dead. So the one outcome that reports absence cannot be fabricated by
 * recycling, while both outcomes that suggest presence can — which is why
 * callers may claim on the first and must claim nothing on the other two.
 * @packageDocumentation
 */

/**
 * What a presence probe established about a PID.
 */
export type ProcessProbeOutcome =
  /**
   * No process holds this PID (`ESRCH`). A live process always has its PID, so
   * the process that held it has ended. This is the only outcome that proves
   * something.
   */
  | 'absent'
  /**
   * A process holds this PID and may be signalled. It may equally be an
   * unrelated process that inherited a recycled PID, so this proves nothing.
   */
  | 'present'
  /**
   * A process holds this PID but nothing further can be established — this
   * runtime may not signal it (`EPERM`, whose common cause is a recycled PID now
   * owned by somebody else), or the query failed for another reason.
   */
  | 'indeterminate';

/**
 * Ask the kernel whether a PID is currently held by any process.
 *
 * Synchronous and immediate: the call returns without waiting for anything, so
 * it adds no bound a caller has to budget for.
 * @param pid - Process identifier to probe.
 * @returns What the probe established — see {@link ProcessProbeOutcome}.
 */
export function probeProcessPresence(pid: number): ProcessProbeOutcome {
  try {
    process.kill(pid, 0);
    return 'present';
  } catch (error) {
    // Anything other than a proven `ESRCH` leaves the PID's holder unknown, and
    // an unknown holder is never reported as absence.
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'absent' : 'indeterminate';
  }
}
