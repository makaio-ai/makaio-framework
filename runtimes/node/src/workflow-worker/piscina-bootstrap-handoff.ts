import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { createBootstrapBudget, withWorkerBootstrapDeadline } from './worker-bootstrap-budget.js';

/** Per-dispatch channel used only to transfer ownership of the bootstrap deadline. */
export interface PiscinaBootstrapBinding {
  /** Original creation-time deadline, shared by host and worker scopes. */
  readonly bootstrapDeadlineAt: string;
  /** Dedicated endpoint transferred exactly once to this task. */
  readonly bootstrapPort: MessagePort;
}

/** Internal protocol, separate from Authority permission and Runtime readiness. */
type BootstrapHandoffMessage = 'takeover' | 'acknowledged';

/**
 * Keep queueing and cold module loading inside the host's original budget.
 * The worker cannot connect until the host removes its timer and acknowledges
 * ownership transfer. Caller cancellation remains linked until the task settles.
 * @param deadlineAt - Original absolute Attempt deadline.
 * @param signal - Caller cancellation for the entire task.
 * @param dispatch - Materialize and dispatch using the task-owned signal and transferred port.
 * @returns The task result, without a host bootstrap timer after handoff.
 */
export async function dispatchWithBootstrapHandoff<T>(
  deadlineAt: string,
  signal: AbortSignal,
  dispatch: (port: MessagePort, taskSignal: AbortSignal) => Promise<T>,
): Promise<T> {
  const channel = new MessageChannel();
  const taskController = new AbortController();
  const cancelTask = (): void => taskController.abort(signal.reason);
  signal.addEventListener('abort', cancelTask, { once: true });
  try {
    const accepted = await withWorkerBootstrapDeadline(deadlineAt, signal, async (bootstrapSignal) => {
      const takeover = waitForHandoffMessage(channel.port1, 'takeover', bootstrapSignal);
      // Observe the original result immediately: a task that exits without
      // requesting ownership must not leave the host waiting for the deadline.
      const result = Promise.resolve().then(() => dispatch(channel.port2, taskController.signal));
      await Promise.race([
        takeover,
        result.then(() => {
          throw new Error('Piscina task completed before bootstrap handoff');
        }),
      ]);
      // Returning the promise directly would keep the host timer alive during
      // invocation. The wrapper carries it across the deadline helper instead.
      return { result };
    });
    createBootstrapBudget(deadlineAt, signal);
    channel.port1.postMessage('acknowledged' satisfies BootstrapHandoffMessage);
    channel.port1.close();
    return await accepted.result;
  } catch (error) {
    taskController.abort(error);
    throw error;
  } finally {
    signal.removeEventListener('abort', cancelTask);
    // port2 is still ours if materialization or queue admission failed before
    // transfer; closing a detached endpoint is harmless after transfer.
    channel.port1.close();
    channel.port2.close();
  }
}

/**
 * Install the worker-side bound before asking the host to relinquish its timer.
 * Only a timely ACK permits the existing runtime bootstrap to begin. Its next
 * scope reuses the same absolute timestamp, never a renewed relative budget.
 * @param binding - Transferred port and original absolute deadline.
 * @param signal - In-process caller cancellation; Piscina itself cancels through its task signal.
 */
export async function acceptPiscinaBootstrapHandoff(
  binding: PiscinaBootstrapBinding,
  signal: AbortSignal = new AbortController().signal,
): Promise<void> {
  try {
    await withWorkerBootstrapDeadline(binding.bootstrapDeadlineAt, signal, (bootstrapSignal) =>
      waitForHandoffMessage(binding.bootstrapPort, 'acknowledged', bootstrapSignal, 'takeover'),
    );
  } finally {
    binding.bootstrapPort.close();
  }
}

/**
 * Own all listeners for one message, including close and deserialization failure.
 * @param port - Dedicated endpoint, never the shared pool's parent port.
 * @param expected - Exactly one permitted protocol response.
 * @param signal - The enclosing deadline scope's cancellation.
 * @param request - Optional message sent only after listeners are installed.
 * @returns Completion when the expected message arrives.
 */
async function waitForHandoffMessage(
  port: MessagePort,
  expected: BootstrapHandoffMessage,
  signal: AbortSignal,
  request?: BootstrapHandoffMessage,
): Promise<void> {
  signal.throwIfAborted();
  const response = Promise.withResolvers<void>();
  const onMessage = (message: unknown): void => {
    if (message === expected) response.resolve();
    else response.reject(new Error('Invalid Piscina bootstrap handoff message'));
  };
  const onClose = (): void => response.reject(new Error('Piscina bootstrap handoff port closed'));
  const onMessageError = (error: Error): void => response.reject(error);
  const onAbort = (): void => response.reject(signal.reason);
  port.on('message', onMessage);
  port.on('messageerror', onMessageError);
  port.on('close', onClose);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    if (request !== undefined) port.postMessage(request);
    await response.promise;
  } finally {
    port.off('message', onMessage);
    port.off('messageerror', onMessageError);
    port.off('close', onClose);
    signal.removeEventListener('abort', onAbort);
  }
}
