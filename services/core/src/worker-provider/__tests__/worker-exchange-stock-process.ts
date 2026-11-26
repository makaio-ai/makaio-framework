import dns from 'node:dns';
import { once } from 'node:events';
import { OrderedWorkerBootstrapAuthSchema, WorkflowWorkerBusAuthSchema } from '@makaio/contracts';
import { createBusNamespace } from '@makaio/core';
import { z } from 'zod';
import {
  runWorkflowInWorker,
  type WorkerConnectorContext,
} from '../../../../../runtimes/node/src/workflow-worker/worker-entry.js';
import { STOCK_CANCEL_SUBJECT, type ExchangeMessage } from './worker-exchange-process-types.js';
import { exchangeStatus } from './worker-exchange-status.js';

const StartMessageSchema = z.strictObject({
  port: z.number().int().positive(),
  requireDecoder: z.boolean(),
  reconnect: z.boolean().optional(),
  auth: z.union([WorkflowWorkerBusAuthSchema, OrderedWorkerBootstrapAuthSchema]),
});
type StartMessage = z.infer<typeof StartMessageSchema>;

/** Interrupt the first lookup for the TLS name in this child, then restore the system resolver. */
function failFirstLocalLookup(): void {
  dns.lookup = new Proxy(dns.lookup, {
    apply(lookup, receiver, args: [string, dns.LookupOptions, (error: NodeJS.ErrnoException) => void]): void {
      if (args[0] !== 'localhost') {
        Reflect.apply(lookup, receiver, args);
        return;
      }
      dns.lookup = lookup;
      const error = Object.assign(new Error('Temporary DNS lookup failure'), { code: 'EAI_AGAIN' });
      queueMicrotask(() => args[2](error));
      process.send?.({ kind: 'stock-dns-interrupted' } satisfies ExchangeMessage);
    },
  });
}

/**
 * Hold only the next real recovery lookup until the replacement is listening.
 * @param signal - Lifetime of the private checked worker probe.
 */
function holdFirstReconnectLookup(signal: AbortSignal): void {
  signal.throwIfAborted();
  const lookup = dns.lookup;
  const restore = (): void => {
    if (dns.lookup === heldLookup) dns.lookup = lookup;
  };
  const heldLookup = new Proxy(lookup, {
    apply(resolver, receiver, args: [string, dns.LookupOptions, (error: NodeJS.ErrnoException) => void]): void {
      if (args[0] !== 'localhost') {
        Reflect.apply(resolver, receiver, args);
        return;
      }
      restore();
      signal.removeEventListener('abort', restore);
      const clear = (): void => {
        process.off('message', release);
        signal.removeEventListener('abort', cancel);
      };
      const release = (command: unknown): void => {
        if (command !== 'release-reconnect-dial') return;
        clear();
        Reflect.apply(resolver, receiver, args);
      };
      const cancel = (): void => {
        clear();
        args[2](Object.assign(new Error('Fixture lookup interrupted'), { code: 'ECONNRESET' }));
      };
      process.on('message', release);
      signal.addEventListener('abort', cancel, { once: true });
      process.send?.({ kind: 'stock-reconnect-dial-held' } satisfies ExchangeMessage);
    },
  });
  dns.lookup = heldLookup;
  signal.addEventListener('abort', restore, { once: true });
}

/**
 * Run the stock entry through its real connection and one authority round trip.
 * @param start - Ordered provider launch message delivered over process IPC.
 */
async function run({ port, auth, requireDecoder, reconnect }: StartMessage): Promise<void> {
  const lookupProbe = process.argv[2];
  const useDns = lookupProbe === 'dns-retry' || lookupProbe === 'hold-reconnect-dial';
  if (lookupProbe === 'dns-retry') failFirstLocalLookup();
  if (auth.kind === 'exchange') {
    const { bootstrapDeadlineAt, replayDeadlineAt } = auth;
    const now = Date.now;
    process.on('message', (command) => {
      if (command !== 'expire-bootstrap' && command !== 'expire-replay') return;
      const deadline = Date.parse(command === 'expire-bootstrap' ? bootstrapDeadlineAt : replayDeadlineAt);
      const adjustment = Math.max(0, deadline + 1 - now());
      Date.now = () => now() + adjustment;
      const event: ExchangeMessage = { kind: 'stock-clock-expired' };
      process.send?.(event);
    });
  }
  const lifetime = new AbortController();
  const stop = (): void => lifetime.abort();
  if (reconnect) process.once('disconnect', stop);
  const namespace = createBusNamespace('exchangeTest', {
    ping: { request: z.object({}), response: z.object({ principal: z.string() }) },
  });
  const measured = new Error('Completed startup probe');
  try {
    await runWorkflowInWorker(
      {
        kind: 'unbound',
        config: {
          source: requireDecoder
            ? { kind: 'path', path: '/missing-workflow-source' }
            : { kind: 'definition', workflowId: 'exchange-probe' },
          workflowId: 'exchange-probe',
          executionId: 'exchange-execution',
          coordinatorSessionId: 'exchange-session',
          cancelSubject: STOCK_CANCEL_SUBJECT,
          busUrl: `wss://${useDns ? 'localhost' : '127.0.0.1'}:${port}/bus`,
          ...(auth.kind === 'exchange' ? { orderedBusAuth: auth } : { busAuth: auth }),
        },
        manifest: { contributionRefs: [] },
        contributionEntrypoints: [],
        signal: lifetime.signal,
      },
      async (context) => {
        if ('orderedBusAuth' in context.config) throw new Error('Worker execution received bootstrap auth');
        if (reconnect) return runReconnectProbe(context);
        const { controller, createConnection } = context;
        const worker = createConnection(undefined, [namespace]);
        const start = performance.now();
        try {
          await worker.connect(controller.signal);
          if (process.env['WORKER_EXCHANGE_TIMINGS'] === '1') {
            const phase: ExchangeMessage = { kind: 'phase', phase: 'connection', ms: performance.now() - start };
            process.send?.(phase);
          }
          if (requireDecoder) return { connection: worker };
          const { principal } = await worker.bus.request(worker.bus.own('root'), namespace.subjects.ping, {});
          const result: ExchangeMessage = { kind: 'stock-accepted', payload: worker.bootstrapPayload, principal };
          process.send?.(result);
        } catch (error) {
          await worker.close();
          throw error;
        }
        await worker.close();
        throw measured;
      },
    );
  } catch (error) {
    if (error !== measured) throw error;
  } finally {
    if (reconnect) {
      process.off('disconnect', stop);
      lifetime.abort();
    }
  }
}

/**
 * Observe the public connector before returning to workflow execution.
 * @param context - The application's public connector context.
 */
async function runReconnectProbe({ controller, createConnection }: WorkerConnectorContext): Promise<never> {
  let holdReconnectDial = process.argv[2] === 'hold-reconnect-dial';
  const worker = createConnection(undefined, [exchangeStatus], async (bus, jobRunId, signal) => {
    const { expiresAt } = await bus.request(bus.own('root'), exchangeStatus.subjects.read, { jobRunId }, { signal });
    if (expiresAt !== undefined) {
      if (holdReconnectDial) {
        holdReconnectDial = false;
        holdFirstReconnectLookup(controller.signal);
      }
      process.send?.({ kind: 'stock-status', expiresAt } satisfies ExchangeMessage);
    }
    return expiresAt;
  });
  const observed = setInterval(() => {
    if (worker.bootstrapPayload !== undefined) {
      process.send?.({ kind: 'valid-bootstrap' } satisfies ExchangeMessage);
      clearInterval(observed);
    }
  }, 5);
  try {
    const { signal } = controller;
    await worker.connect(signal);
    if (!signal.aborted) await once(signal, 'abort');
    if (signal.reason instanceof DOMException && signal.reason.name === 'AbortError') {
      process.send?.({ kind: 'stock-cancelled' } satisfies ExchangeMessage);
    }
    throw signal.reason;
  } finally {
    clearInterval(observed);
    await worker.close();
  }
}

try {
  if (process.env['WORKER_EXCHANGE_TIMINGS'] === '1') {
    const phase: ExchangeMessage = { kind: 'phase', phase: 'worker modules', ms: performance.now() };
    process.send?.(phase);
  }
  const [start]: unknown[] = await once(process, 'message');
  await run(StartMessageSchema.parse(start));
} catch (error) {
  const code =
    error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'startup-failed';
  const result: ExchangeMessage = {
    kind: 'stock-stopped',
    code,
    decoderRequired: error instanceof Error && error.message === 'Ordered worker requires a bound order decoder',
  };
  process.send?.(result);
} finally {
  if (process.connected) process.disconnect?.();
}
