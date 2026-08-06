/**
 * Watching a killed tmux pane's process end.
 * @packageDocumentation
 */
import { reportObservedExit } from '@makaio/ai-adapters-core';
import type { ConnectorTeardownResult } from '@makaio/contracts';
import { DeferredPromise } from '@makaio/utils';
import type { ITmuxPtyProcess } from '../types.js';

/** One session's pane-exit subscription and the observation it settles. */
export interface PaneExitSubscription {
  /**
   * Settled by the pane process's own exit event, once per session.
   *
   * The backend publishes exits through a callback only, so before this promise a
   * teardown had nothing to await: it could kill and return, and "the call
   * returned" was the only fact available to it.
   */
  readonly exited: Promise<void>;
  /** Release the underlying listener; safe after the exit has been observed. */
  readonly dispose: () => void;
}

/**
 * Subscribe to a pane's process exit, settling one observation for two consumers.
 *
 * Built in the shape the shared ACP client uses — one promise per session, settled
 * from inside the listener that is already there — so the exit is observed once
 * and there is no second subscription to keep in step. The two consumers are the
 * turn finalisation this connector always did and the teardown's observation, and
 * they read the same single event.
 * @param ptyProcess - Pane process whose exit the backend publishes.
 * @param finalizeTurn - Fails the active turn when the process died mid-turn.
 * @returns The awaitable observation and the listener's release.
 */
export function subscribePaneExit(
  ptyProcess: ITmuxPtyProcess,
  finalizeTurn: (exitCode: number, signal?: number) => Promise<void>,
): PaneExitSubscription {
  const settled = new DeferredPromise<void>();
  const disposable = ptyProcess.onExit((event) => {
    settled.resolve(undefined);
    void finalizeTurn(event.exitCode, event.signal);
  });
  return { exited: settled.getPromise(), dispose: () => disposable.dispose() };
}

/**
 * Report what a teardown observed about the end of its pane process.
 *
 * The backend publishes an exit only when a tmux server established the session's
 * absence, or when the pane PID turned out to be held by nobody. So the promise
 * settling *is* the observation, and waiting for it inside the exit budget is the
 * difference between having asked for a kill and having watched one.
 *
 * **Without a subscription the answer depends on whether a process could exist,
 * and only one of the two answers is `released`.** A teardown rolling back an
 * initialization that failed before the spawn was ever requested reports
 * `released`: nothing was started, so nothing can still be speaking. But a
 * teardown that lands *between* the spawn request and the subscription — a close
 * arriving while `backend.spawn()` is in flight — has no subscription either, and
 * for it `released` would be a claim about a process it never saw start, let alone
 * end. That case is capped at `detached`: this runtime stopped holding whatever it
 * spawned and cannot say more, which is the honest end of a kill nobody watched.
 * @param subscription - Exit subscription for the session being torn down, if any.
 * @param spawnStarted - Whether this connector had already asked the backend to
 *   spawn a pane, whether or not the request had returned one.
 * @returns `exited` when the end was published, `detached` when it was not, and
 *   `released` only when no pane process was ever asked for.
 */
export async function observePaneExit(
  subscription: PaneExitSubscription | undefined,
  spawnStarted: boolean,
): Promise<ConnectorTeardownResult> {
  if (subscription === undefined) {
    if (!spawnStarted) return { evidence: 'released' };
    return {
      evidence: 'detached',
      detail: 'The tmux pane process was spawned before this teardown could subscribe to its exit.',
    };
  }
  return reportObservedExit({ exited: subscription.exited, resource: 'The tmux pane process' });
}
