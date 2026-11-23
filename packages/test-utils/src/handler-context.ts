/**
 * Handler contexts for tests.
 *
 * Builds the `RequestContext` a request handler receives, so handlers can be
 * called directly in a unit test. The result mechanics are real (a local cell),
 * not mock functions.
 */
import type { CallContext } from '@makaio/contracts';
import type { RequestContext } from '@makaio/core';
import { createTestCall } from './call-context.js';

/** Options of {@link createTestHandlerContext}. */
export interface TestHandlerContextOptions {
  /** Call context of the handled message. Defaults to `createTestCall()`. */
  readonly call?: CallContext;
  /** Identifier of the message. Defaults to a random UUID. */
  readonly messageId?: string;
}

/**
 * Build a request handler context for a test.
 *
 * `setResult`, `result`, `extendResult` and `replacePayload` work on local state:
 * `result` reads what `setResult` or `extendResult` stored, `extendResult`
 * shallow-merges into it (starting from an empty object), and `replacePayload`
 * changes `payload`. `next` resolves without calling anything.
 * @param payload - The request payload.
 * @param options - Call context and message id; see {@link TestHandlerContextOptions}.
 * @returns A request context with working result mechanics.
 */
export function createTestHandlerContext<Payload, Response = unknown>(
  payload: Payload,
  options: TestHandlerContextOptions = {},
): RequestContext<Payload, Response> {
  let currentPayload = payload;
  let currentResult: unknown;

  return {
    messageId:
      options.messageId ??
      globalThis.crypto?.randomUUID?.() ??
      `fallback-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    call: options.call ?? createTestCall(),
    isRequest: true,
    get payload(): Payload {
      return currentPayload;
    },
    get result(): Response | undefined {
      // The cell only ever holds what `setResult` stored or a merge of it.
      return currentResult as Response | undefined;
    },
    setResult: (result: Response): void => {
      currentResult = result;
    },
    extendResult: (extension: unknown): void => {
      const base = typeof currentResult === 'object' && currentResult !== null ? currentResult : {};
      const addition = typeof extension === 'object' && extension !== null ? extension : {};
      currentResult = { ...base, ...addition };
    },
    next: (): Promise<void> => Promise.resolve(),
    replacePayload: (newPayload: Payload): void => {
      currentPayload = newPayload;
    },
  };
}
