import type { StepProcessResult } from '../step-interface-schemas.js';
import { Console } from 'node:console';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { createJsonRpcClient, type JsonlChannel, type TransportEnd } from '@makaio/subprocess';
import {
  AgentStepProcessFailureSchema,
  AgentStepProcessInputSchema,
  LocalModelAddressSchema,
  type AgentStepProcessFailure,
} from './protocol.js';
import { createTextAgentStepAdapter } from './text-adapter.js';

/**
 * Invoke one fresh agent turn from the supervisor's data-only request.
 * @param message - Initial JSON message received on the worker's pipe.
 * @param signal - Aborted when the worker closes the pipe.
 * @returns A terminal step result containing only structured output, usage, or a fixed error code.
 */
async function executeAgentStep(message: string, signal: AbortSignal): Promise<StepProcessResult> {
  const started = performance.now();
  const failed = (error: AgentStepProcessFailure): StepProcessResult => ({
    status: 'failed',
    error,
    telemetry: { duration: performance.now() - started },
  });
  const modelAddress = LocalModelAddressSchema.safeParse(process.env['MAKAIO_MODEL_ADDRESS']);
  if (!modelAddress.success) return failed('environmentMissing');
  const input = AgentStepProcessInputSchema.safeParse(JSON.parse(message));
  if (!input.success) return failed('agent-start-refused');
  const { adapterId, ownerInstanceId } = input.data;
  const adapter = createTextAgentStepAdapter(adapterId, ownerInstanceId);
  const execution = adapter.start(
    { request: { ...input.data, role: 'member' }, auth: { kind: 'none' }, modelAddress: modelAddress.data },
    signal,
  );
  if (execution.turn === undefined) return failed(execution.reason ?? 'agent-start-refused');
  const turn = await execution.turn;
  if (turn.kind === 'cancelled') return { status: 'cancelled', telemetry: { duration: performance.now() - started } };
  if (turn.kind === 'failed') {
    const reason = AgentStepProcessFailureSchema.safeParse(turn.reason);
    return failed(reason.success ? reason.data : 'agent-turn-failed');
  }
  const { output, usage } = turn.result;
  return {
    status: 'completed',
    output,
    telemetry: {
      duration: performance.now() - started,
      ...(usage === undefined ? {} : { tokenUsage: { input: usage.inputTokens, output: usage.outputTokens } }),
    },
  };
}

Object.defineProperty(globalThis, 'console', {
  configurable: true,
  writable: true,
  value: new Console(process.stderr, process.stderr),
});

const lines = createInterface({ input: process.stdin });
const lifetime = new AbortController();
const ended = once(lines, 'close').then((): TransportEnd => {
  lifetime.abort();
  return {
    cause: 'unexpected',
    exit: { kind: 'unobserved', reason: 'observation-timeout' },
    drain: { kind: 'complete', discardedChars: 0 },
    communicationFailure: undefined,
    tree: { kind: 'not-owned' },
  };
});
try {
  const [message] = await once(lines, 'line');
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
      process.stdout.write(`${JSON.stringify(value)}\n`);
    },
  };
  const rpc = createJsonRpcClient(channel);
  const result = await executeAgentStep(String(message), lifetime.signal);
  await rpc.request('output.submit', result);
} catch {
  process.exitCode = 1;
} finally {
  lines.close();
  process.stdin.pause();
}

// The worker acknowledged the result or closed the channel.
process.exit(process.exitCode);
