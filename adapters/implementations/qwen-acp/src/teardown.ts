/**
 * The class a qwen ACP teardown may claim, the generation bookkeeping that can
 * cap it, and the bounded stage a graceful close runs first.
 *
 * Kept beside the connector rather than inside it because the questions are
 * separable: the connector owns *when* a generation is superseded, this module
 * owns *what may be claimed* once one was — and the budget a close spends before
 * it starts killing.
 * @packageDocumentation
 */
import type { ConnectorTeardownResult } from '@makaio/contracts';
import { GenerationRetirementLedger, withTimeout, type SupersededGeneration } from '@makaio/ai-adapters-core';
import type { AcpConnectionHandle } from '@makaio/ai-adapters-acp-client';

/** What a qwen ACP process generation is called in a teardown `detail`. */
const QWEN_ACP_RESOURCE = 'qwen ACP process';

/** What a qwen terminal child is called in a teardown `detail`. */
const QWEN_TERMINAL_RESOURCE = 'qwen terminal process';

/** Milliseconds a graceful close waits for the agent to acknowledge `session/cancel`. */
const CANCEL_ACK_BUDGET_MS = 2_000;

/**
 * Ask the agent to end its turn, and stop waiting when the budget is spent.
 *
 * **Bounded by the shared `withTimeout` rather than by a local race**, because a
 * hand-rolled race has no way to clear its own timer: on the far more common path
 * — the agent *does* acknowledge — the expiry stayed armed and held the event loop
 * for the rest of the budget, in the one path a process is trying to leave.
 *
 * The bound applies to the wait, not to the work, and an unacknowledged cancel is
 * not a teardown failure: the kill that follows ends the turn either way, so this
 * resolves on every path and reports nothing.
 * @param interrupt - The connector's best-effort cancel.
 */
export async function awaitCancelAcknowledgement(interrupt: () => Promise<void>): Promise<void> {
  try {
    await withTimeout(interrupt(), CANCEL_ACK_BUDGET_MS, 'qwen ACP session/cancel was not acknowledged.');
  } catch {
    // Bounded on purpose; the caller kills next either way.
  }
}

/** Everything one clear of the connector's session state took out of service. */
export interface QwenSupersededGenerations {
  /** The live ACP process generation, when there was one. */
  readonly process: SupersededGeneration | undefined;
  /** Terminal children released with it, one generation each. */
  readonly terminals: readonly SupersededGeneration[];
}

/**
 * The unretired-generation record for both kinds of process a qwen connector
 * spawns, and everything a teardown does with it.
 *
 * **Two ledgers rather than one,** because the `detail` a capped class carries has
 * to name the thing a human should go looking for, and "the ACP agent may still be
 * running" and "a terminal child may still be running" send them to different
 * places. A single {@link cap} covers both, so no report path can weaken for one
 * record and forget the other.
 *
 * Terminal children belong here at all because they are **spawned resources**, not
 * somebody else's descendants: the shared ACP client spawns them itself and holds
 * an exit promise for each. Their unwatched ends are what I33 caps a class for, and
 * the evidence was always there — only its consumption was missing.
 */
export class QwenRetirementLedgers {
  /** Generations of the `qwen` ACP process itself. */
  public readonly process = new GenerationRetirementLedger(QWEN_ACP_RESOURCE);
  /** Terminal children the shared ACP client spawned on this connector's behalf. */
  public readonly terminals = new GenerationRetirementLedger(QWEN_TERMINAL_RESOURCE);

  /**
   * Signal one spawned ACP process's end and book it as unproven (I33).
   *
   * **The single generation-retirement choke point.** The kill and the booking are
   * one act in one place, because a caller that kills without booking produces
   * exactly the dishonesty I33 exists to prevent: a process the connector
   * signalled, that nothing ever watched, and a later teardown reporting
   * `released` over it.
   *
   * It takes the handle rather than reading the connector's field, because not
   * every generation reaches that field — a handshake that fails leaves its process
   * owned only by the local variable that created it, and that generation needs
   * retiring just as much as a published one.
   * @param handle - Connection handle whose process is being taken out of service.
   * @returns The superseded generation, to retire or abandon.
   */
  public supersedeProcess(handle: AcpConnectionHandle): SupersededGeneration {
    handle.kill();
    return this.process.supersede(handle.exited);
  }

  /**
   * Book every terminal child the connector's manager just released (I33).
   * @param released - Exit observations handed back by `releaseAll`.
   * @returns One superseded generation per released terminal.
   */
  public supersedeTerminals(released: ReadonlyArray<Promise<unknown>>): SupersededGeneration[] {
    return released.map((exited) => this.terminals.supersede(exited));
  }

  /**
   * End one process and give up on observing it, in a single act.
   *
   * For the paths that hold a bare handle and cannot wait — a failed handshake owes
   * its caller an error promptly. The cap is what keeps giving up honest.
   * @param handle - Connection handle whose process is being ended.
   */
  public abandonProcess(handle: AcpConnectionHandle): void {
    this.process.abandon(this.supersedeProcess(handle));
  }

  /**
   * Give up on observing every end one clear signalled.
   *
   * The synchronous half of the split, for `abort()`: it cannot await anything, so
   * it signals the ends and lets the cap carry the non-observation.
   * @param superseded - Generations the clear took out of service.
   */
  public abandon(superseded: QwenSupersededGenerations): void {
    if (superseded.process !== undefined) this.process.abandon(superseded.process);
    for (const terminal of superseded.terminals) this.terminals.abandon(terminal);
  }

  /**
   * Consume every end one clear signalled, inside the observation budget.
   *
   * Concurrently, because the budget answers one question — "did these end" — and
   * spending it once per resource would make a teardown's duration a function of
   * how many terminals the agent happened to open.
   * @param superseded - Generations the clear took out of service.
   */
  public async retire(superseded: QwenSupersededGenerations): Promise<void> {
    await Promise.all([
      superseded.process === undefined ? undefined : this.process.retire(superseded.process),
      ...superseded.terminals.map((terminal) => this.terminals.retire(terminal)),
    ]);
  }

  /**
   * Report the class a graceful qwen close may claim.
   *
   * **The evidence is a set of promises, read in the one place a generation
   * retires.** The shared ACP client settles an exit observation for every process
   * it spawns — the agent and each terminal child alike — and this awaits the ones
   * belonging to the generations the close just superseded, inside the exit budget.
   *
   * A close that found no live process claims `released`: nothing of its own was
   * spawned, every in-process handle is dropped, and no callback can arrive
   * afterwards. Either claim is then capped, which is where an end that never
   * arrived — the agent's or an unreaped terminal child's — becomes `detached`.
   * That single downgrade path is why the claim below is stated as if every end had
   * been watched: two paths that had to agree would eventually not.
   * @param superseded - Generations this close took out of service.
   * @returns The class this teardown may claim.
   */
  public async reportClose(superseded: QwenSupersededGenerations): Promise<ConnectorTeardownResult> {
    await this.retire(superseded);
    return this.cap({ evidence: superseded.process === undefined ? 'released' : 'exited' });
  }

  /**
   * Apply both records' ceilings to a reported class.
   * @param result - Class the teardown computed for what it did observe.
   * @returns The class capped by every generation whose end went unobserved.
   */
  public cap(result: ConnectorTeardownResult): ConnectorTeardownResult {
    return this.terminals.capReport(this.process.capReport(result));
  }
}
