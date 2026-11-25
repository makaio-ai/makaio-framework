import type { WorkerModelInvocation, WorkerModelPort, WorkerModelResult } from './model-mediator.js';
import { AgentModelReplySchema, MODEL_MESSAGE_LIMIT_BYTES, serializeModelMessage } from './protocol.js';

// Short strings, even when encoded, are likely to occur in ordinary model output.
const MIN_MODEL_CREDENTIAL_BYTES = 16;
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

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
 * Search the stable base64 core and validate the boundary bits at each match.
 * @param text - Normalized base64 reply text.
 * @param core - Encoded characters independent of neighboring bytes.
 * @param matchesEdges - Check the shared sextets immediately outside the core.
 * @returns Whether an exact match exists.
 */
function hasMatchingCore(text: string, core: string, matchesEdges: (start: number, end: number) => boolean): boolean {
  if (core.length > text.length) return false;
  // Reuse matching prefixes so overlapping cores cannot make the search quadratic.
  const prefixes = new Uint32Array(core.length);
  for (let index = 1, length = 0; index < core.length; index += 1) {
    while (length > 0 && core[index] !== core[length]) length = prefixes[length - 1] ?? 0;
    if (core[index] === core[length]) length += 1;
    prefixes[index] = length;
  }
  for (let index = 0, length = 0; index < text.length; index += 1) {
    while (length > 0 && text[index] !== core[length]) length = prefixes[length - 1] ?? 0;
    if (text[index] === core[length]) length += 1;
    if (length === core.length) {
      if (matchesEdges(index + 1 - length, index + 1)) return true;
      length = prefixes[length - 1] ?? 0;
    }
  }
  return false;
}

/**
 * Search a base64 representation for credential bytes at any position in a three-byte group.
 * @param text - Reply with both base64 alphabets normalized and ASCII whitespace removed.
 * @param credential - Bytes of one representation of the authorization value.
 * @returns Whether every credential bit matches, including the bits shared with neighboring bytes.
 */
function containsBase64Credential(text: string, credential: Buffer): boolean {
  for (const prefixBytes of [0, 1, 2]) {
    const encoded = Buffer.concat([Buffer.alloc(prefixBytes), credential]).toString('base64url');
    const startBit = prefixBytes * 8;
    const endBit = startBit + credential.length * 8;
    const start = Math.ceil(startBit / 6);
    const end = Math.floor(endBit / 6);
    const core = encoded.slice(start, end);
    const leadingBits = start * 6 - startBit;
    const trailingBits = endBit - end * 6;
    const leadingMask = (1 << leadingBits) - 1;
    const trailingMask = 63 ^ ((1 << (6 - trailingBits)) - 1);
    const leading = BASE64URL_ALPHABET.indexOf(encoded.charAt(start - 1)) & leadingMask;
    const trailing = BASE64URL_ALPHABET.indexOf(encoded.charAt(end)) & trailingMask;
    const matches = hasMatchingCore(text, core, (coreStart, coreEnd) => {
      const before = BASE64URL_ALPHABET.indexOf(text[coreStart - 1] ?? '\0');
      const after = BASE64URL_ALPHABET.indexOf(text[coreEnd] ?? '\0');
      return (
        (leadingMask === 0 || (before >= 0 && (before & leadingMask) === leading)) &&
        (trailingMask === 0 || (after >= 0 && (after & trailingMask) === trailing))
      );
    });
    if (matches) return true;
  }
  return false;
}

/**
 * Check reply text for any credential used during the invocation.
 * @param text - A serialized reply or its decoded model text.
 * @param credentials - Authorization values already sent to the model upstream.
 * @returns Whether the reply contains a credential in a recognized representation.
 */
function reflectsCredential(text: string, credentials: ReadonlySet<string>): boolean {
  const escaped = Buffer.from(text)
    .toString('latin1')
    .replace(/%[\da-f]{2}/gi, (byte) => String.fromCharCode(Number.parseInt(byte.slice(1), 16)));
  const base64 = text
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/[ \t\r\n\f\v]/g, '');
  for (const credential of credentials) {
    const bytes = Buffer.from(credential);
    if (text.includes(credential)) return true;
    // HTTP headers carry Latin-1 bytes. A provider may encode either those bytes or the decoded text.
    const representations = bytes.length === credential.length ? [bytes] : [bytes, Buffer.from(credential, 'latin1')];
    for (const representation of representations) {
      if (escaped.includes(representation.toString('latin1')) || containsBase64Credential(base64, representation)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Send and decode one authorized upstream attempt.
 * @param url - Configured upstream URL.
 * @param body - Snapshot of the serialized request.
 * @param credential - In-memory authorization for this attempt.
 * @param signal - Lifetime of the authorized effect.
 * @param credentials - Authorization values shared by the attempts of this invocation.
 * @returns The turn outcome, or a request to refresh on HTTP 401.
 */
async function send(
  url: URL,
  body: string,
  credential: string,
  signal: AbortSignal,
  credentials: Set<string>,
): Promise<WorkerModelResult | 'refresh'> {
  signal.throwIfAborted();
  const headers = new Headers({ authorization: `Bearer ${credential}`, 'content-type': 'application/json' });
  const sent = headers.get('authorization')?.replace(/^Bearer[ \t]*/, '') ?? '';
  if (sent.length < MIN_MODEL_CREDENTIAL_BYTES) {
    return { kind: 'failed', code: 'environmentMissing' };
  }
  credentials.add(sent);
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body,
    redirect: 'error',
    signal,
  });
  if (response.ok) {
    const decoded = await readReply(response).catch(() => undefined);
    const reply = AgentModelReplySchema.safeParse(decoded);
    if (reply.success) {
      const serialized = serializeModelMessage(reply.data);
      if (
        serialized !== undefined &&
        !reflectsCredential(serialized, credentials) &&
        !reflectsCredential(reply.data.text, credentials)
      ) {
        return { kind: 'completed', reply: reply.data };
      }
    }
    return { kind: 'failed', code: 'reply-invalid' };
  }
  // Error bodies stay upstream. Only fixed failure codes can cross the step boundary.
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
  const credentials = new Set<string>();
  for (const reason of ['initial', 'refresh'] as const) {
    signal.throwIfAborted();
    if ('withCredential' in credentialSource) {
      const upstreamScope = credentialSource.modelScope(url.href);
      if (upstreamScope === undefined) return refused;
      const attempt = await credentialSource.withCredential(call, upstreamScope, signal, (credential, effectSignal) =>
        send(url, body, credential.reveal(), effectSignal, credentials).catch(
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
      const result = await send(url, body, grant.credential, signal, credentials);
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
