import type { WorkerModelInvocation, WorkerModelPort, WorkerModelResult } from './model-mediator.js';
import { AgentModelReplySchema, MODEL_MESSAGE_LIMIT_BYTES } from './protocol.js';

/**
 * Decode an upstream reply only if its streamed body fits the wire limit.
 * @param response - Reply from the explicitly configured upstream.
 * @returns Decoded JSON, or undefined for an absent or oversized body.
 */
async function readReply(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (reader === undefined) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    const encoding = response.headers.get('content-encoding');
    const length = Number(response.headers.get('content-length'));
    // For compressed replies, Content-Length measures encoded bytes. The reader measures decoded bytes.
    if ((encoding === null || encoding === 'identity') && length > MODEL_MESSAGE_LIMIT_BYTES) return undefined;
    for (;;) {
      const entry = await reader.read();
      if (entry.done) break;
      size += entry.value.byteLength;
      if (size > MODEL_MESSAGE_LIMIT_BYTES) return undefined;
      chunks.push(entry.value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * Forward one model turn to the configured upstream and refresh authorization once on HTTP 401.
 * @param input - Scoped model invocation from the worker mediator.
 * @param url - Address of the configured upstream model endpoint.
 * @returns The terminal turn reply or a content-free failure.
 */
async function complete(input: WorkerModelInvocation, url: URL): Promise<WorkerModelResult> {
  for (const reason of ['initial', 'refresh'] as const) {
    input.signal.throwIfAborted();
    const grant = await input.credentialSource.request(input.call, {
      purpose: 'model.use',
      target: input.target,
      signal: input.signal,
      reason,
    });
    if (grant.kind === 'purpose-not-granted') return { kind: 'failed', code: 'environmentMissing' };
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${grant.credential}`, 'content-type': 'application/json' },
      body: JSON.stringify(input.request),
      redirect: 'error',
      signal: input.signal,
    });
    if (response.ok) {
      const body = await readReply(response).catch(() => undefined);
      const reply = AgentModelReplySchema.safeParse(body);
      return reply.success ? { kind: 'completed', reply: reply.data } : { kind: 'failed', code: 'reply-invalid' };
    }
    await response.body?.cancel();
    if (response.status !== 401) break;
  }
  return { kind: 'failed', code: 'upstream-failed' };
}

/**
 * Create the worker-side port for one model and an explicitly named upstream.
 * @param modelId - Model selected by the resolved role.
 * @param target - Target name and upstream HTTPS or loopback URL supplied by the worker owner.
 * @returns A model port that rejects invocations for a different target or model.
 */
export function createHttpWorkerModelPort(
  modelId: string,
  target: { readonly name: string; readonly url: URL },
): WorkerModelPort {
  const url = new URL(target.url);
  const loopback = url.protocol === 'http:' && url.hostname === '127.0.0.1';
  if ((url.protocol !== 'https:' && !loopback) || url.username !== '' || url.password !== '') {
    throw new Error('Invalid model upstream');
  }
  const targetName = target.name;
  return {
    modelId,
    complete: (input) => {
      if (input.target !== targetName) return Promise.resolve({ kind: 'failed', code: 'environmentMissing' });
      if (input.request.model !== modelId) return Promise.resolve({ kind: 'failed', code: 'model-not-in-session' });
      return complete(input, url).catch(() => ({ kind: 'failed', code: 'upstream-failed' }));
    },
  };
}
