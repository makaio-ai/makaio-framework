import {
  createJsonlDecoder,
  type JsonlChannel,
  type ExecutionSiteHandle,
  type SiteLaunchResult,
  type MessageListener,
  type TransportEnd,
} from '@makaio/subprocess';

/** Channel dedicated to the child process, with framing validity available to the result consumer. */
export interface CodeStepResultChannel extends JsonlChannel {
  readonly validFraming: boolean;
  readonly rejectedFraming: boolean;
}

/**
 * Interpret the launcher's terminal facts for the JSON-RPC client's connection.
 * @param result - Outcome of the bounded launch.
 * @param complete - Whether stdout reached its own end.
 * @returns End of the exchange.
 */
function transportEnd(result: SiteLaunchResult, complete: boolean): TransportEnd {
  const cause =
    result.status === 'spawn-failed'
      ? 'spawn-failed'
      : result.status === 'cancelled' || result.status === 'timed-out' || result.status === 'output-limit'
        ? 'requested'
        : 'unexpected';
  return {
    cause,
    exit:
      result.exitCode === undefined
        ? { kind: 'unobserved', reason: 'observation-timeout' }
        : { kind: 'exited', code: result.exitCode, signal: null },
    drain: complete ? { kind: 'complete', discardedChars: 0 } : { kind: 'abandoned', discardedChars: 0 },
    communicationFailure: undefined,
    tree: result.containment?.kind === 'quiescent' ? { kind: 'quiescent' } : { kind: 'not-owned' },
  };
}

/**
 * Identify messages that will reach the JSON-RPC client's request handler.
 * @param message - One decoded frame from the child.
 * @returns Whether the client can correlate it to a request.
 */
function isRequestFrame(message: unknown): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    'method' in message &&
    'id' in message &&
    (typeof message.id === 'number' || typeof message.id === 'string')
  );
}

/**
 * Bind the launcher's bounded pipes to the existing JSON-RPC client.
 * @param child - Launched child, with piped stdin and captured stdout.
 * @param stop - Requests cancellation of the owned group.
 * @param limitBytes - Output budget of the launch.
 * @returns Channel for the code step process and its framing evidence.
 */
export function bindCodeStepResultChannel(
  child: Required<Pick<ExecutionSiteHandle, 'result' | 'stdin' | 'stdout'>>,
  stop: AbortController,
  limitBytes: number,
): CodeStepResultChannel {
  const listeners = new Set<MessageListener>();
  const decoder = createJsonlDecoder({ finalLine: 'discard', maxLineLength: limitBytes });
  const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let valid = true;
  const rejectFraming = (): void => {
    valid = false;
    stop.abort();
  };
  const deliver = (text: string): void => {
    const batch = decoder.push(text);
    if (batch.malformedLineCount !== 0 || batch.oversizedLineCount !== 0) {
      rejectFraming();
      return;
    }
    for (const message of batch.messages) {
      if (!isRequestFrame(message)) {
        rejectFraming();
        return;
      }
      for (const listener of listeners) listener(message);
    }
  };
  const reader = child.stdout.getReader();
  const writer = child.stdin.getWriter();
  let complete = false;
  const drain = async (): Promise<void> => {
    let receivedBytes = 0;
    try {
      while (valid) {
        const { done, value } = await reader.read();
        if (done) {
          deliver(utf8.decode());
          if (decoder.end().discardedChars !== 0) rejectFraming();
          complete = true;
          return;
        }
        receivedBytes += value.byteLength;
        if (receivedBytes > limitBytes) return;
        deliver(utf8.decode(value, { stream: true }));
      }
    } catch {
      rejectFraming();
    } finally {
      reader.releaseLock();
    }
  };
  const ended = Promise.all([child.result, drain()]).then(([result]) => {
    if (!complete) decoder.abandon();
    listeners.clear();
    writer.releaseLock();
    return transportEnd(result, complete);
  });
  return {
    ended,
    close: () => {
      stop.abort();
      return ended;
    },
    onMessage: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send: (message) => {
      void writer.write(new TextEncoder().encode(`${JSON.stringify(message)}\n`)).catch(() => undefined);
    },
    get rejectedFraming() {
      return stop.signal.aborted && !valid;
    },
    get validFraming() {
      return valid && complete;
    },
  };
}
