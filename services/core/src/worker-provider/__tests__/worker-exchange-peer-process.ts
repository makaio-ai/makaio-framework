import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  WorkerExchangeReplySchema,
  WorkerRunIdentityReplySchema,
  type WorkerExchangeRequest,
  type WorkerRunIdentityRequest,
} from '@makaio/contracts/boundary';
import { JobRunOutcomeNamespace, OutcomeSubmitResponseSchema } from '@makaio/contracts/workflow';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { waitForCapacityRefusal, waitForSilentClose } from './worker-exchange-capacity-peer.js';
import {
  RUN_ID,
  OTHER_RUN_ID,
  LOCAL_DELIVERY_SUBJECT,
  TEST_EXCHANGE_BUDGET,
  TEST_SUBJECT,
  type ExchangeMessage,
  ExchangePeerStartSchema,
  type ExchangeScenario,
} from './worker-exchange-process-types.js';

const scenario = process.argv[2] as ExchangeScenario;
const directory = process.argv[3] ?? '';
if (!process.connected) process.exit();
process.once('disconnect', () => process.exit(process.exitCode ?? 0));
const [start]: unknown[] = await once(process, 'message');
const { port, proof, otherRun, host = '127.0.0.1' } = ExchangePeerStartSchema.parse(start);
const protocol = scenario === 'plaintext' ? 'ws' : 'wss';
const base = `${protocol}://${host}:${port}`;
const ca = scenario === 'untrusted' ? undefined : await readFile(join(directory, 'cert.pem'));
const connectFrame = z.looseObject({
  type: z.string(),
  namespace: z.string().optional(),
  subject: z.string().optional(),
  correlationId: z.string().optional(),
  reject: z.string().optional(),
  result: z.unknown().optional(),
});
const request = {
  type: 'request',
  namespace: 'exchangeTest',
  subject: 'ping',
  messageId: 'probe',
  correlationId: 'probe',
  payload: {},
} as const;
const localSession =
  scenario === 'local-revoke' ||
  scenario === 'local-expiry' ||
  scenario === 'local-promotion' ||
  scenario === 'local-promotion-hangs' ||
  scenario === 'local-promotion-repeats' ||
  scenario === 'local-takeover' ||
  scenario === 'local-takeover-invalidates' ||
  scenario === 'local-takeover-identity' ||
  scenario === 'two-host-revoke';

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
  return new WebSocket(`${protocol}://${host}:${targetPort}${path}`, {
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
  const outcome = bindOutcomeProbe(socket);
  const drop = Promise.withResolvers<void>();
  const dropListener = (message: unknown): void => {
    if (message === 'drop') drop.resolve();
    else if (message === 'pause-wire') {
      socket.pause();
      report({ kind: 'local-peer-paused' });
    } else if (message === 'resume-wire') socket.resume();
    else if (message === 'probe') socket.send(JSON.stringify(request));
    else if (message === 'probe-held') {
      socket.send(JSON.stringify({ ...request, correlationId: 'held', payload: { hold: true } }));
    }
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
        if (scenario === 'boot-supported') {
          const result = WorkerExchangeReplySchema.safeParse(reply);
          if (!result.success || !('payload' in result.data) || !result.data.payload) {
            report({ kind: 'failed', stage: 'unexpected boot redemption reply' });
            return;
          }
        }
        if (scenario === 'local-takeover-identity') {
          const identityReply = WorkerRunIdentityReplySchema.safeParse(reply);
          if (!identityReply.success || identityReply.data.identity.jobRunId !== RUN_ID) {
            report({ kind: 'failed', stage: 'unexpected identity reply' });
            return;
          }
          report({ kind: 'local-takeover-identity', expiresAt: identityReply.data.identity.expiresAt });
        }
        bytes = Buffer.byteLength(encoded);
        successReplies += 1;
      }
    } else if (reply.type === 'subscribe-sync-complete') {
      if (scenario === 'boot-supported') {
        if (successReplies !== 1) throw new Error('Expected one accepted boot exchange');
        report({ kind: 'boot-worker-redeemed' });
        return;
      }
      if (localSession && !otherRun) {
        socket.send(JSON.stringify({ type: 'subscribe', subjects: { [LOCAL_DELIVERY_SUBJECT]: [] } }));
      }
      socket.send(JSON.stringify(request));
    } else if (
      (scenario === 'local-promotion' || scenario === 'local-takeover-identity') &&
      reply.type === 'event' &&
      `${reply.namespace}.${reply.subject}` === LOCAL_DELIVERY_SUBJECT
    ) {
      report({ kind: 'local-route-delivered' });
    } else if (reply.type === 'response') {
      if (outcome.handle(reply)) return;
      const result = z.object({ principal: z.string() }).safeParse(reply.result);
      if (reply.correlationId !== request.correlationId || !result.success) {
        report({ kind: 'failed', stage: 'unexpected response' });
      } else {
        report({ kind: 'accepted', bytes, principal: result.data.principal });
      }
      if (!localSession) socket.close();
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
  await outcome.stop();
  process.off('message', dropListener);
}

/**
 * Exercise the live outcome protocol on the same socket used for bootstrap.
 * @param socket - Redeeming worker socket.
 * @returns Response and teardown callbacks.
 */
function bindOutcomeProbe(socket: WebSocket) {
  let submitted = false;
  const subject = JobRunOutcomeNamespace.subjects.outcome.submit;
  const send = (correlationId: string, workflowId: string, done?: (error?: Error) => void) =>
    socket.send(
      JSON.stringify({
        type: 'request',
        namespace: subject.$meta.namespace,
        subject: subject.subject,
        correlationId,
        messageId: correlationId,
        payload: { result: { jobRunId: RUN_ID, workflowId, status: 'completed' } },
      }),
      done,
    );
  const listen = (command: unknown) => {
    if (command === 'submit-rollback') send('rollback', 'rollback');
    if (command === 'submit-result') {
      submitted = true;
      send('outcome', 'workflow');
    }
    if (command === 'probe-retiring') {
      send('retiring', 'workflow');
      socket.ping();
    }
  };
  process.on('message', listen);
  return {
    handle(reply: z.infer<typeof connectFrame>) {
      const { correlationId, result } = reply;
      if (correlationId === 'retiring') {
        report({ kind: 'failed', stage: 'retired connection accepted another request' });
        return true;
      }
      if (correlationId !== 'outcome' && correlationId !== 'rollback') return false;
      const parsed = OutcomeSubmitResponseSchema.safeParse(result);
      const outcome = parsed.data;
      if (correlationId === 'rollback' && outcome?.decision === 'refused' && outcome.code === 'fixture-rollback') {
        report({ kind: 'outcome-response', decision: 'refused' });
      } else if (correlationId === 'outcome' && outcome?.decision === 'accepted' && outcome.answer === 'stored') {
        report({ kind: 'outcome-response', decision: 'accepted' });
      } else {
        report({ kind: 'failed', stage: 'unexpected outcome response' });
      }
      return true;
    },
    async stop() {
      process.off('message', listen);
      if (!submitted) return;
      await new Promise<void>((resolve) => {
        send('closed', 'workflow', (error) => {
          report({ kind: 'outcome-after-close', rejected: error !== undefined });
          resolve();
        });
      });
    },
  };
}

/** @returns The single deliberate presentation for the current scenario. */
function presentation(): string {
  if (scenario === 'malformed') return '{';
  if (scenario.startsWith('identity-') || scenario === 'local-takeover-identity') {
    const identity: WorkerRunIdentityRequest = {
      kind: 'job-run',
      jobRunId: RUN_ID,
      runtimeSecret: scenario === 'identity-wrong' ? 'different-test-secret' : 'runtime-fixture-secret',
    };
    return JSON.stringify(identity);
  }
  const jobRunId = otherRun
    ? OTHER_RUN_ID
    : scenario === 'unknown'
      ? 'different-run'
      : scenario === 'rollback'
        ? 'storage-reject'
        : RUN_ID;
  const input: WorkerExchangeRequest = {
    type: 'connection-exchange',
    exchange: 'makaio.worker.redeem',
    presented: {
      jobRunId,
      oneTimeToken: scenario === 'foreign' ? 'other-run-token' : 'initial-token',
      runtimeSecret: scenario === 'wrong-secret' ? 'different-test-secret' : 'runtime-fixture-secret',
      proof: scenario === 'proof' || scenario === 'proof-replay' ? 'another-allocation' : proof,
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
