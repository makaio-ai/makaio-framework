import type { WorkerModelInvocation, WorkerModelPort, WorkerModelResult } from './model-mediator.js';
import { AgentModelReplySchema, MODEL_MESSAGE_LIMIT_BYTES, serializeModelMessage } from './protocol.js';

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
 * Check the serialized reply and its text for the authorization used on this attempt.
 * @param body - Serialized body that would cross the process boundary.
 * @param text - Decoded model text, including characters escaped by JSON.
 * @param credential - Plaintext used in the authorization header.
 * @returns Whether the reply contains the credential in a recognized encoding.
 */
function reflectsCredential(body: string, text: string, credential: string): boolean {
  if (credential.length === 0) return false;
  const bytes = Buffer.from(credential, 'utf8');
  const uri = encodeURIComponent(credential);
  const base64 = bytes.toString('base64');
  const encodings = [
    credential,
    uri,
    uri.replace(/%[A-F0-9]{2}/g, (byte) => byte.toLowerCase()),
    base64,
    base64.replace(/=+$/, ''),
    bytes.toString('base64url'),
  ];
  return encodings.some((value) => body.includes(value) || text.includes(value));
}

/**
 * Send and decode one authorized upstream attempt.
 * @param url - Configured upstream URL.
 * @param body - Snapshot of the serialized request.
 * @param credential - In-memory authorization for this attempt.
 * @param signal - Lifetime of the authorized effect.
 * @param checkReflection - Reject reflected authorization for a run-scoped attempt.
 * @returns The turn outcome, or a request to refresh on HTTP 401.
 */
async function send(
  url: URL,
  body: string,
  credential: string,
  signal: AbortSignal,
  checkReflection = false,
): Promise<WorkerModelResult | 'refresh'> {
  signal.throwIfAborted();
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
    body,
    redirect: 'error',
    signal,
  });
  if (response.ok) {
    const decoded = await readReply(response).catch(() => undefined);
    const reply = AgentModelReplySchema.safeParse(decoded);
    if (checkReflection && reply.success) {
      const body = serializeModelMessage(reply.data);
      if (body === undefined || reflectsCredential(body, reply.data.text, credential)) {
        return { kind: 'failed', code: 'reply-invalid' };
      }
    }
    return reply.success ? { kind: 'completed', reply: reply.data } : { kind: 'failed', code: 'reply-invalid' };
  }
  await response.body?.cancel();
  return response.status === 401 ? 'refresh' : { kind: 'failed', code: 'upstream-failed' };
}

/**
 * Forward one model turn to the configured upstream and refresh authorization once on HTTP 401.
 * @param input - Scoped model invocation from the worker mediator.
 * @param url - Address of the configured upstream model endpoint.
 * @returns The terminal turn reply or a content-free failure.
 */
async function complete(input: WorkerModelInvocation, url: URL): Promise<WorkerModelResult> {
  const { call, credentialSource, target, signal } = Object.freeze({ ...input });
  const body = JSON.stringify(input.request);
  const scope = Object.freeze({ purpose: 'model.use', target } as const);
  const refused = { kind: 'failed', code: 'environmentMissing' } as const;
  for (const reason of ['initial', 'refresh'] as const) {
    signal.throwIfAborted();
    if ('withCredential' in credentialSource) {
      const upstreamScope = credentialSource.modelScope(url.href);
      if (upstreamScope === undefined) return refused;
      const attempt = await credentialSource.withCredential(call, upstreamScope, signal, (credential, effectSignal) =>
        send(url, body, credential.reveal(), effectSignal, true).catch(
          () => ({ kind: 'failed', code: 'upstream-failed' }) as const,
        ),
      );
      if (attempt.kind !== 'granted' || !attempt.isCurrent()) return refused;
      if (attempt.value !== 'refresh') {
        return attempt.value.kind === 'completed' ? { ...attempt.value, isCurrent: attempt.isCurrent } : attempt.value;
      }
    } else {
      const grant = await credentialSource.request(call, Object.freeze({ ...scope, signal, reason }));
      if (grant.kind === 'purpose-not-granted') return refused;
      const result = await send(url, body, grant.credential, signal);
      if (result !== 'refresh') return result;
    }
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
