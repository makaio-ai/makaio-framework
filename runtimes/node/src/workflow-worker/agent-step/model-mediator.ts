import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { CallContext } from '@makaio/contracts/call-context';
import {
  AgentModelReplySchema,
  AgentModelRequestSchema,
  ModelFailureCodeSchema,
  type AgentModelRequest,
  type AgentModelReply,
  type ModelFailureCode,
} from './protocol.js';

const MAX_REQUEST_BYTES = 128 * 1024;

/** Worker-owned model invocation. The adapter never receives this port or its authorization. */
export interface WorkerModelPort {
  readonly modelId: string;
  complete(input: WorkerModelInvocation): Promise<WorkerModelResult>;
}

/** Arguments of one worker-owned upstream model request. */
export interface WorkerModelInvocation {
  readonly call: CallContext;
  readonly request: AgentModelRequest;
  readonly credential: string;
  readonly signal: AbortSignal;
}

/** A terminal request outcome or the failure to confirm lease closure. */
export type ModelMediationOutcome =
  | { readonly kind: 'completed'; readonly usage?: AgentModelReply['usage'] }
  | { readonly kind: 'failed'; readonly code: ModelFailureCode }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'close-timed-out' };

/** Typed reply from the trusted worker model port. */
export type WorkerModelResult =
  | { readonly kind: 'completed'; readonly reply: AgentModelReply }
  | { readonly kind: 'failed'; readonly code: ModelFailureCode };

/** The worker owns the session, upstream credential and time bounds. */
export interface LocalModelOptions {
  readonly call: CallContext;
  readonly model: WorkerModelPort;
  readonly credential: string;
  readonly signal: AbortSignal;
  readonly requestTimeoutMs: number;
  readonly onOutcome?: (outcome: ModelMediationOutcome) => void;
}

/** A local model address valid for one agent session. */
export interface LocalModelLease {
  readonly address: string;
  /**
   * Call this explicitly to observe unconfirmed closure, including without a diagnostic sink.
   * @returns A promise that rejects if closure is unconfirmed.
   */
  close(): Promise<void>;
}

/**
 * Read one bounded JSON model request.
 * @param request - Model request from the agent process.
 * @returns Parsed JSON, or undefined for an invalid request.
 */
async function readModelRequest(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    if (!Buffer.isBuffer(chunk)) throw new Error('Invalid model request bytes');
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) return undefined;
    chunks.push(chunk);
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}

/**
 * Open a loopback listener and obtain its assigned port.
 * @param server - Model mediator.
 * @returns The listening port.
 */
async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Local model address unavailable');
  return address.port;
}

/**
 * Publish diagnostics without affecting the request or lease.
 * @param options - Options containing the diagnostic sink.
 * @param outcome - Content-free request or lease outcome.
 */
function report(options: LocalModelOptions, outcome: ModelMediationOutcome): void {
  try {
    options.onOutcome?.(outcome);
  } catch {
    /* The sink cannot affect delivery. */
  }
}

/**
 * Serve a scoped request with content-free diagnostics.
 * @param request - Client request.
 * @param allowed - Whether the request addresses the lease.
 * @param response - Client response.
 * @param options - Session and model policy.
 * @param lifetime - Session cancellation.
 * @param pending - Upstream operations to join on close.
 * @returns A promise that settles after the request is handled.
 */
async function handleModel(
  request: IncomingMessage,
  allowed: boolean,
  response: ServerResponse,
  options: LocalModelOptions,
  lifetime: AbortSignal,
  pending: Set<Promise<WorkerModelResult>>,
): Promise<void> {
  const disconnected = new AbortController();
  response.once('close', () => disconnected.abort());
  const timeout = AbortSignal.timeout(options.requestTimeoutMs);
  const signal = AbortSignal.any([lifetime, disconnected.signal, timeout]);
  let finished = false;
  const finish = (outcome: ModelMediationOutcome): void => {
    if (finished) return;
    finished = true;
    report(options, outcome);
  };
  const fail = (status: number, code: ModelFailureCode): void => {
    if (finished) return;
    finish({ kind: 'failed', code });
    response
      .writeHead(status, { 'content-type': 'application/json', connection: 'close' })
      .end(JSON.stringify({ code }));
  };
  const onAbort = (): void => {
    if (timeout.aborted && signal.reason === timeout.reason) fail(504, 'request-timed-out');
    else finish({ kind: 'cancelled' });
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal.aborted) return onAbort();
    if (!allowed) return fail(404, 'request-invalid');
    const payload = await readModelRequest(request).catch(() => null);
    if (signal.aborted) return;
    if (payload === null && request.destroyed && !request.complete) return finish({ kind: 'cancelled' });
    if (payload === undefined) return fail(413, 'request-too-large');
    const input = AgentModelRequestSchema.safeParse(payload);
    if (!input.success) {
      if (input.error.issues.some((issue) => issue.code === 'too_big')) return fail(413, 'request-too-large');
      return fail(400, 'request-invalid');
    }
    if (input.data.stream === true) return fail(400, 'streaming-unsupported');
    if (input.data.model !== options.model.modelId) return fail(403, 'model-not-in-session');
    const operation = options.model.complete({
      call: options.call,
      request: input.data,
      credential: options.credential,
      signal,
    });
    pending.add(operation);
    const result = await operation.finally(() => pending.delete(operation));
    if (signal.aborted) return;
    if (result.kind !== 'completed') {
      const code = ModelFailureCodeSchema.safeParse(result.code);
      return fail(502, code.success ? code.data : 'upstream-failed');
    }
    const output = AgentModelReplySchema.safeParse(result.reply);
    if (!output.success) return fail(502, 'reply-invalid');
    finish({ kind: 'completed', usage: output.data.usage });
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(output.data));
  } catch {
    fail(502, 'upstream-failed');
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Open an authenticated capability on the worker's loopback address.
 * @param options - Authority, upstream port, credential and lifetime.
 * @returns The revocable session address.
 */
export async function openLocalModelAddress(options: LocalModelOptions): Promise<LocalModelLease> {
  const { signal, requestTimeoutMs } = options;
  if (signal.aborted) throw new Error('Model mediation was cancelled');
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 2_147_483_647) {
    throw new Error('Invalid model request timeout');
  }
  const path = `/model/${randomUUID()}`;
  const lifetime = new AbortController();
  const pending = new Set<Promise<WorkerModelResult>>();
  const server = createServer((request, response) => {
    const allowed = request.url === path && request.method === 'POST';
    void handleModel(request, allowed, response, options, lifetime.signal, pending);
  });
  const port = await listen(server);
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing !== undefined) return closing;
    const listenerStopped = new Promise<void>((resolve) => server.close(() => resolve()));
    closing = listenerStopped.then(async () => {
      if (pending.size === 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled(pending),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              report(options, { kind: 'close-timed-out' });
              reject(new Error('Model port did not stop'));
            }, requestTimeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    });
    lifetime.abort();
    signal.removeEventListener('abort', onAbort);
    server.closeAllConnections();
    return closing;
  };
  const onAbort = (): void => {
    void close().catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) {
    await close();
    throw new Error('Model mediation was cancelled');
  }
  return { address: `http://127.0.0.1:${port}${path}`, close };
}
