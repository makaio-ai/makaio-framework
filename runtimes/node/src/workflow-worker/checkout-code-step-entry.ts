import { Console } from 'node:console';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import {
  JsonValueSchema,
  WorkflowError,
  WorkflowErrorCode,
  type StepContext,
  type StepRunResult,
} from '@makaio/contracts';
import { createJsonRpcClient, type JsonlChannel, type TransportEnd } from '@makaio/subprocess';
import { abortableWait } from '@makaio/utils';
import { loadWorkflowFromCheckout } from './checkout-workflow-reader.js';
import {
  CheckoutCodeStepInputSchema,
  STEP_EXECUTION_FAILED,
  StepProcessLaunchRefusalSchema,
  StepRequestCallResultSchema,
  type CheckoutCodeStepInput,
} from './step-interface-schemas.js';

/**
 * Evaluate one workflow and call only its selected handler.
 * @param invocation - Data-only invocation received on stdin.
 * @param rpc - Connection back to the worker on the dedicated pipes.
 * @param signal - Cooperative cancellation for the checkout handler.
 * @returns The checkout handler's terminal result.
 */
async function executeStep(
  invocation: CheckoutCodeStepInput,
  rpc: ReturnType<typeof createJsonRpcClient>,
  signal: AbortSignal,
): Promise<StepRunResult> {
  const started = performance.now();
  const failed = (error: string): StepRunResult => ({
    status: 'failed',
    error,
    telemetry: { duration: performance.now() - started },
  });
  const loaded = await loadWorkflowFromCheckout(invocation.source).catch((error: unknown) =>
    error instanceof WorkflowError ? error.code : STEP_EXECUTION_FAILED,
  );
  signal.throwIfAborted();
  if (typeof loaded === 'string') return failed(loaded);
  const handler = loaded.runtimeHandlers.get(invocation.step);
  if (handler === undefined) return failed(WorkflowErrorCode.HANDLER_UNAVAILABLE);
  try {
    const context: StepContext = {
      ...invocation.input,
      signal,
      request: async (params) => StepRequestCallResultSchema.parse(await rpc.request('request.call', params)),
      launchProcess: async (params) =>
        StepProcessLaunchRefusalSchema.parse(await rpc.request('process.launch', params)),
    };
    const output = JsonValueSchema.parse(await handler(context));
    return { status: 'completed', output, telemetry: { duration: performance.now() - started } };
  } catch {
    return failed(STEP_EXECUTION_FAILED);
  }
}

// Reserve the launcher's stdout pipe for RPC before evaluating checkout code.
// Ordinary Node stdout writes share the bounded diagnostic pipe with console output.
const writeProtocol = process.stdout.write.bind(process.stdout);
process.stdout.write = process.stderr.write.bind(process.stderr);
Object.defineProperty(globalThis, 'console', {
  configurable: true,
  writable: true,
  value: new Console(process.stderr, process.stderr),
});

const lines = createInterface({ input: process.stdin });
const controller = new AbortController();
const { signal } = controller;
const stop = (): void => controller.abort();
process.once('SIGTERM', stop);
lines.once('close', stop);
try {
  const [message] = await once(lines, 'line', { signal });
  const input = CheckoutCodeStepInputSchema.parse(JSON.parse(String(message)));
  const ended = once(lines, 'close').then(
    (): TransportEnd => ({
      cause: 'unexpected',
      exit: { kind: 'unobserved', reason: 'observation-timeout' },
      drain: { kind: 'complete', discardedChars: 0 },
      communicationFailure: undefined,
      tree: { kind: 'not-owned' },
    }),
  );
  const channel: JsonlChannel = {
    ended,
    close: () => {
      lines.close();
      return ended;
    },
    onMessage: (listener) => {
      const receive = (line: string): void => {
        listener(JSON.parse(line));
      };
      lines.on('line', receive);
      return () => lines.off('line', receive);
    },
    send: (value) => {
      writeProtocol(`${JSON.stringify(value)}\n`);
    },
  };
  const rpc = createJsonRpcClient(channel);
  const work = executeStep(input, rpc, signal).then(async (result) => {
    signal.throwIfAborted();
    await rpc.request('output.submit', result);
  });
  await abortableWait(work, signal);
} catch (error) {
  if (!signal.aborted) throw error;
} finally {
  process.off('SIGTERM', stop);
  lines.off('close', stop);
  lines.close();
  process.stdin.pause();
}

// The worker acknowledged the result or owns cancellation. Close any open handles with the process.
process.exit(0);
