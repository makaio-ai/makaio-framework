import { findInErrorChain, TimeoutError, type IMakaioBus } from '@makaio/bus-core';
import {
  ACCESS_DENIED_ERROR_CODE,
  CODE_STEP_REQUEST_REJECTED,
  CodeStepRequestInputSchema,
  isJsonObject,
  JsonValueSchema,
  type CodeStepHandler,
  type CodeStepRequestInput,
  type CodeStepRequestResult,
} from '@makaio/contracts';
import { splitSubjectKey, type CallContext } from '@makaio/core';
import type { RuntimeLoadedWorkflow } from './types.js';

/**
 * Send a concrete request over the caller-local worker's existing host connection.
 * @param bus - The connected worker bus.
 * @param call - Call owned by the worker for this run.
 * @param input - Qualified subject and fully parsed JSON payload.
 * @param signal - Cancellation for this Step occurrence.
 * @returns A JSON reply or a fixed diagnostic for a refused or failed request.
 */
async function requestHost(
  bus: IMakaioBus,
  call: CallContext,
  { subject, payload }: CodeStepRequestInput,
  signal: AbortSignal,
): Promise<CodeStepRequestResult> {
  const target = splitSubjectKey(subject);
  if (target === undefined || subject.includes('*')) return { ok: false, code: 'request-not-granted' };
  if (!isJsonObject(payload)) return { ok: false, code: CODE_STEP_REQUEST_REJECTED };
  const definition = {
    subject: target.subject,
    $meta: {
      namespace: target.namespace,
      isRequest: true,
      channel: false,
      local: false,
      payload: { request: {}, response: {} },
    },
  } as const;
  try {
    const result = await bus.requestOptional(call, definition, payload, { signal });
    if (!result.handled) return { ok: false, code: 'request-not-granted', detail: 'No host handler for this subject' };
    const json = JsonValueSchema.safeParse(result.data);
    if (json.success) return { ok: true, response: json.data };
    return { ok: false, code: 'request-failed', detail: 'Host response is not a JSON value' };
  } catch (error) {
    const denied = findInErrorChain(error, (entry) => (entry.code === ACCESS_DENIED_ERROR_CODE ? true : undefined));
    if (denied) return { ok: false, code: 'request-not-granted', detail: 'Host refused the request' };
    if (signal.aborted) return { ok: false, code: 'request-failed', detail: 'Host request was cancelled' };
    if (error instanceof TimeoutError) return { ok: false, code: 'request-failed', detail: 'Host request timed out' };
    return { ok: false, code: 'request-failed', detail: 'Host request failed' };
  }
}

/**
 * Bind file handlers to the standard worker's host connection for host-only subjects.
 * @param loaded - Workflow loaded by this caller-local worker.
 * @param bus - The worker bus created by the standard connector.
 * @param call - Call owned by the worker for this run.
 * @returns The workflow with its per-handler request capability bound.
 */
export function bindFileStepRequests(
  loaded: RuntimeLoadedWorkflow,
  bus: IMakaioBus,
  call: CallContext,
): RuntimeLoadedWorkflow {
  const runtimeHandlers = new Map<string, CodeStepHandler>();
  for (const [id, handler] of loaded.runtimeHandlers) {
    runtimeHandlers.set(id, (context) =>
      handler({
        ...context,
        request: (input) => {
          const parsed = CodeStepRequestInputSchema.safeParse(input);
          if (!parsed.success || bus.getSchema(parsed.data.subject) !== undefined) return context.request(input);
          return requestHost(bus, call, parsed.data, context.signal);
        },
      }),
    );
  }
  return { ...loaded, runtimeHandlers };
}
