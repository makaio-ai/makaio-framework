import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkerExchangeRequest } from '@makaio/contracts/boundary';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { waitForCapacityRefusal, waitForSilentClose } from './worker-exchange-capacity-peer.js';
import {
  RUN_ID,
  TEST_EXCHANGE_BUDGET,
  TEST_SUBJECT,
  type ExchangeMessage,
  type ExchangeScenario,
} from './worker-exchange-process-types.js';

const scenario = process.argv[2] as ExchangeScenario;
const directory = process.argv[3] ?? '';
if (!process.connected) process.exit();
process.once('disconnect', () => process.exit(process.exitCode ?? 0));
const [port] = await once(process, 'message');
if (typeof port !== 'number') throw new Error('Missing test listener endpoint');
const protocol = scenario === 'plaintext' ? 'ws' : 'wss';
const base = `${protocol}://127.0.0.1:${port}`;
const ca = scenario === 'untrusted' ? undefined : await readFile(join(directory, 'cert.pem'));
const connectFrame = z.looseObject({
  type: z.string(),
  correlationId: z.string().optional(),
  reject: z.string().optional(),
  result: z.object({ principal: z.string() }).optional(),
});
const request = {
  type: 'request',
  namespace: 'exchangeTest',
  subject: 'ping',
  messageId: 'probe',
  correlationId: 'probe',
  payload: {},
} as const;

/**
 * Send only public measurements and test milestones to the supervisor.
 * @param message - Test result or barrier.
 */
function report(message: ExchangeMessage): void {
  if (process.connected) process.send?.(message, undefined, undefined, () => {});
}

/** Exercise the existing client auth and readiness route. */
async function runLegacy(): Promise<void> {
  const { HmacAuth, WebSocketClientTransport } = await import('@makaio/bus-transport-websocket');
  const transport = new WebSocketClientTransport({
    url: `${base}/bus`,
    auth: new HmacAuth({ secret: 'shared-test-credential' }),
    autoReconnect: false,
    createWebSocket: (url) => new WebSocket(url, { ca }),
  });
  try {
    await transport.connect();
    await transport.ready;
    const result = await transport.send(request);
    if (typeof result !== 'object' || result === null || !('principal' in result)) throw new Error('Missing principal');
    report({ kind: 'accepted', bytes: 0, principal: String(result.principal) });
  } finally {
    await transport.disconnect();
  }
}

/**
 * @param targetPort - Active listener, including a replacement after shutdown.
 * @returns A native socket configured for the test scenario.
 */
function connectExchange(targetPort = port): WebSocket {
  const path = scenario === 'anonymous' ? '/bus' : '/bus/exchange';
  return new WebSocket(`${protocol}://127.0.0.1:${targetPort}${path}`, {
    ca,
    // This header is synthetic and carries no upgrade authority.
    headers: scenario === 'plaintext' ? { 'X-Forwarded-Proto': 'https' } : undefined,
  });
}

/**
 * Run one exchange using the native WebSocket client and real wire frames.
 * @param socket - Test socket, optionally already open and waiting for its first frame.
 */
async function runExchange(socket = connectExchange()): Promise<void> {
  const drop = Promise.withResolvers<void>();
  const dropListener = (message: unknown): void => {
    if (message === 'drop') drop.resolve();
  };
  process.on('message', dropListener);
  let rejectedTls = false;
  let refusal: string | undefined;
  let elapsed = 0;
  let sentAt = 0;
  let bytes = 0;
  let successReplies = 0;
  socket.on('error', () => {
    rejectedTls = scenario === 'untrusted';
    if (!rejectedTls) socket.terminate();
  });
  socket.on('message', (data) => {
    const encoded = data.toString();
    const parsed = connectFrame.safeParse(JSON.parse(encoded));
    if (!parsed.success) return;
    const reply = parsed.data;
    if (reply.type === 'auth-challenge') {
      socket.send(JSON.stringify({ type: 'auth-response', signature: '0'.repeat(64) }));
    } else if (reply.type === 'connection-exchange-result') {
      elapsed = performance.now() - sentAt;
      if (reply.reject !== undefined) refusal = encoded;
      else {
        bytes = Buffer.byteLength(encoded);
        successReplies += 1;
      }
    } else if (reply.type === 'subscribe-sync-complete') {
      socket.send(JSON.stringify(request));
    } else if (reply.type === 'response') {
      if (reply.correlationId !== request.correlationId || reply.result === undefined) {
        report({ kind: 'failed', stage: 'unexpected response' });
      } else {
        report({ kind: 'accepted', bytes, principal: reply.result.principal });
      }
      socket.close();
    }
  });
  socket.on('pong', () => report({ kind: 'preframes' }));
  const sendPresentation = (): void => {
    sentAt = performance.now();
    socket.send(scenario === 'anonymous' ? JSON.stringify(request) : presentation());
    if (scenario === 'committed' || scenario === 'dropped') {
      socket.send(JSON.stringify({ ...request, correlationId: 'early' }));
      socket.send(JSON.stringify({ type: 'subscribe', subjects: { [TEST_SUBJECT]: [] } }));
      socket.send(JSON.stringify({ type: 'subscribe', subjects: { [TEST_SUBJECT]: [10] } }));
      socket.ping();
    }
    void drop.promise.then(() => socket.close());
  };
  if (socket.readyState === WebSocket.OPEN) sendPresentation();
  else socket.once('open', sendPresentation);
  await new Promise<void>((resolve) =>
    socket.once('close', (code) => {
      if (rejectedTls) report({ kind: 'tls-rejected' });
      else
        report({
          kind: 'closed',
          code,
          reply: refusal,
          latencyMs: elapsed || performance.now() - sentAt,
          successReplies,
        });
      resolve();
    }),
  );
  process.off('message', dropListener);
}

/** @returns The single deliberate presentation for the current scenario. */
function presentation(): string {
  if (scenario === 'malformed') return '{';
  const jobRunId = scenario === 'unknown' ? 'different-run' : scenario === 'rollback' ? 'storage-reject' : RUN_ID;
  const input: WorkerExchangeRequest = {
    type: 'connection-exchange',
    exchange: 'makaio.worker.redeem',
    presented: {
      jobRunId,
      oneTimeToken: scenario === 'foreign' ? 'other-run-token' : 'initial-token',
      runtimeSecret: scenario === 'wrong-secret' ? 'different-test-secret' : 'runtime-fixture-secret',
      proof: scenario === 'proof' ? 'another-allocation' : jobRunId,
    },
  };
  const frame = JSON.stringify(input);
  return scenario === 'oversized' ? frame.padEnd(TEST_EXCHANGE_BUDGET + 1) : frame;
}

try {
  if (scenario === 'legacy') await runLegacy();
  else if (scenario === 'capacity') await runExchange(await waitForCapacityRefusal(connectExchange, report));
  else if (scenario === 'silent') {
    await waitForSilentClose(connectExchange, report);
    await runExchange();
  } else if (
    scenario === 'dropped-commit' ||
    scenario === 'deadline-after-commit' ||
    scenario === 'transport-stopped'
  ) {
    const replay = Promise.withResolvers<number>();
    const replayListener = (message: unknown): void => {
      if (message !== 'replay' && typeof message !== 'number') return;
      process.off('message', replayListener);
      replay.resolve(message === 'replay' ? port : message);
    };
    process.on('message', replayListener);
    await runExchange();
    await runExchange(connectExchange(await replay.promise));
  } else await runExchange();
} catch (error) {
  report({ kind: 'failed', stage: error instanceof Error ? error.name : 'peer' });
  process.exitCode = 1;
} finally {
  if (process.connected) process.disconnect?.();
}
