import { createServer, request as requestHttp } from 'node:http';
import { MakaioBus } from '@makaio/bus-core';
import { describe, expect, it } from 'vitest';
import { openLocalModelAddress, type ModelMediationOutcome, type WorkerModelPort } from './model-mediator.js';
import { AgentStepCapabilitiesSchema, type ModelFailureCode } from './protocol.js';
import { createTextAgentStepAdapter } from './text-adapter.js';

const adapter = createTextAgentStepAdapter('text-model', 'worker-instance');
const step = {
  request: { adapterId: 'text-model', role: 'member', model: 'stub', initialMessage: 'check the change' },
  auth: { kind: 'none' },
};

const exampleAddress = 'http://127.0.0.1:1/model/00000000-0000-0000-0000-000000000000';
const reviewBody = JSON.stringify({ model: 'stub', prompt: 'review' });

/** Hold the upstream model open until its invocation signal aborts. */
function createPendingModel() {
  const entered = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<unknown>();
  const model: WorkerModelPort = {
    modelId: 'stub',
    complete: ({ signal }) =>
      new Promise((_, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            const reason: unknown = signal.reason;
            aborted.resolve(reason);
            reject(new Error('Model stopped'));
          },
          { once: true },
        );
        entered.resolve();
      }),
  };
  return { model, entered: entered.promise, aborted: aborted.promise };
}

describe('isolated text agent adapter', () => {
  it('declares an address need and completes through the worker-owned model port', async () => {
    const call = MakaioBus.own('root');
    const signal = new AbortController().signal;
    const credential = 'synthetic-upstream-authorization';
    const outcomes: ModelMediationOutcome[] = [];
    const lease = await openLocalModelAddress({
      call,
      model: {
        modelId: 'stub',
        complete: async ({ call: received, request: input, credential: authorization }) => {
          expect(received).toBe(call);
          expect(authorization).toBe(credential);
          expect(input).toEqual({ model: 'stub', prompt: 'check the change' });
          const reply = { text: 'done', providerMetadata: authorization };
          return { kind: 'completed', reply };
        },
      },
      credential,
      signal,
      requestTimeoutMs: 2000,
      onOutcome: (outcome) => {
        outcomes.push(outcome);
        throw new Error('Diagnostic sink failed');
      },
    });
    try {
      expect(AgentStepCapabilitiesSchema.parse(adapter.capabilities).environment).toEqual([
        { name: 'MAKAIO_MODEL_ADDRESS', source: 'makaio.model-address' },
      ]);
      expect(lease.address.includes(credential)).toBe(false);
      const execution = adapter.start({ ...step, modelAddress: lease.address }, signal);
      expect(execution.start).toMatchObject({
        success: true,
        adapterId: 'text-model',
        ownerInstanceId: 'worker-instance',
      });
      await expect(execution.turn).resolves.toEqual({ kind: 'completed', result: { text: 'done' } });
      const response = await fetch(lease.address, {
        method: 'POST',
        body: JSON.stringify({ model: 'stub', prompt: 'check the change' }),
      });
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).not.toContain(credential);
      expect(JSON.parse(body)).toEqual({ text: 'done' });
      expect(outcomes).toEqual([{ kind: 'completed' }, { kind: 'completed' }]);
    } finally {
      await lease.close();
    }
  });

  it('reports one failure for each refused model request', async () => {
    const outcomes: ModelMediationOutcome[] = [];
    const signal = new AbortController().signal;
    const lease = await openLocalModelAddress({
      call: MakaioBus.own('root'),
      model: {
        modelId: 'stub',
        complete: async () => {
          throw new Error('Unexpected model request');
        },
      },
      credential: 'synthetic-authorization',
      signal,
      requestTimeoutMs: 2000,
      onOutcome: (outcome) => outcomes.push(outcome),
    });
    try {
      const response = await fetch(new URL('/model/not-this-session', lease.address), { method: 'POST' });
      expect(response.status).toBe(404);
      const oversized = await fetch(lease.address, { method: 'POST', body: 'x'.repeat(129 * 1024) });
      expect(oversized.status).toBe(413);
      await expect(oversized.json()).resolves.toEqual({ code: 'request-too-large' });
      for (const [body, code] of [
        ['{', 'request-invalid'],
        [JSON.stringify({ model: 'stub', prompt: 'x'.repeat(16_385) }), 'request-too-large'],
        [JSON.stringify({ model: 'other', prompt: 'review' }), 'model-not-in-session'],
        [JSON.stringify({ model: 'stub', prompt: 'review', stream: true }), 'streaming-unsupported'],
      ]) {
        const rejected = await fetch(lease.address, { method: 'POST', body });
        await expect(rejected.json()).resolves.toEqual({ code });
      }
      expect(outcomes).toEqual([
        { kind: 'failed', code: 'request-invalid' },
        { kind: 'failed', code: 'request-too-large' },
        { kind: 'failed', code: 'request-invalid' },
        { kind: 'failed', code: 'request-too-large' },
        { kind: 'failed', code: 'model-not-in-session' },
        { kind: 'failed', code: 'streaming-unsupported' },
      ]);
    } finally {
      await lease.close();
    }
  });

  it.each([
    ['missing model address', step],
    ['credential delivery', { ...step, modelAddress: exampleAddress, auth: { kind: 'env' } }],
    [
      'different worker',
      { ...step, modelAddress: exampleAddress, request: { ...step.request, ownerInstanceId: 'other-worker' } },
    ],
    [
      'session resume',
      {
        ...step,
        modelAddress: exampleAddress,
        request: { ...step.request, mode: 'resume', sessionId: 'session', adapterSessionId: 'native' },
      },
    ],
  ])('refuses adapter start with %s', (_description, input) => {
    expect(adapter.start(input, new AbortController().signal).start).toMatchObject({
      success: false,
      dispatch: 'not-dispatched',
    });
  });

  it.each([
    'mcpSessionContext',
    'sessionContext',
    'clientProfileName',
    'harnessId',
    'clientId',
    'ephemeral',
    'reasoningEffort',
    'systemPrompt',
  ])('identifies the unsupported adapter start field %s', (field) => {
    const input = { ...step, modelAddress: exampleAddress, request: { ...step.request, [field]: undefined } };
    const { start } = adapter.start(input, new AbortController().signal);
    expect(start).toMatchObject({ success: false, dispatch: 'not-dispatched' });
    expect(JSON.stringify(start)).toContain(`Unsupported agent step start field: ${field}`);
  });

  it('bounds an unsupported field name in the diagnostic', () => {
    const field = 'unexpected'.repeat(12);
    const input = { ...step, modelAddress: exampleAddress, request: { ...step.request, [field]: undefined } };
    const { start } = adapter.start(input, new AbortController().signal);
    expect(start).toMatchObject({
      success: false,
      dispatch: 'not-dispatched',
      message: `Unsupported agent step start field: ${field.slice(0, 64)}`,
    });
  });

  it('preserves provider output errors without exposing upstream credentials', async () => {
    const signal = new AbortController().signal;
    const credential = 'synthetic-worker-authorization';
    const lease = await openLocalModelAddress({
      call: MakaioBus.own('root'),
      model: {
        modelId: 'stub',
        complete: async ({ request: input }) => {
          if (input.prompt === 'throw') throw new Error(credential);
          if (input.prompt === 'unknown code') return { kind: 'failed', code: credential as ModelFailureCode };
          const reply = input.prompt === 'missing text' ? JSON.parse('{}') : { text: '' };
          return { kind: 'completed', reply };
        },
      },
      credential,
      signal,
      requestTimeoutMs: 2000,
    });
    try {
      const execution = adapter.start({ ...step, modelAddress: lease.address }, signal);
      await expect(execution.turn).resolves.toEqual({ kind: 'failed', reason: 'reply-invalid' });
      const missingText = await fetch(lease.address, {
        method: 'POST',
        body: JSON.stringify({ model: 'stub', prompt: 'missing text' }),
      });
      expect(missingText.status).toBe(502);
      await expect(missingText.json()).resolves.toEqual({ code: 'reply-invalid' });
      for (const prompt of ['throw', 'unknown code']) {
        const failure = await fetch(lease.address, { method: 'POST', body: JSON.stringify({ model: 'stub', prompt }) });
        expect(failure.status).toBe(502);
        const body = await failure.text();
        expect(body).not.toContain(credential);
        expect(JSON.parse(body)).toEqual({ code: 'upstream-failed' });
      }
    } finally {
      await lease.close();
    }
  });

  it('reports request timeout and separately rejects an unconfirmed close', async () => {
    const uncooperative = Promise.withResolvers<never>();
    const outcomes: ModelMediationOutcome[] = [];
    const lease = await openLocalModelAddress({
      call: MakaioBus.own('root'),
      signal: new AbortController().signal,
      credential: 'synthetic-authorization',
      requestTimeoutMs: 500,
      model: { modelId: 'stub', complete: () => uncooperative.promise },
      onOutcome: (outcome) => outcomes.push(outcome),
    });
    try {
      const sent = await fetch(lease.address, { method: 'POST', body: reviewBody });
      await expect(sent.json()).resolves.toEqual({ code: 'request-timed-out' });
      await expect(lease.close()).rejects.toThrow('Model port did not stop');
      expect(outcomes).toEqual([{ kind: 'failed', code: 'request-timed-out' }, { kind: 'close-timed-out' }]);
    } finally {
      uncooperative.reject(new Error('Fixture complete'));
      await lease.close().catch(() => undefined);
    }
  });

  it('reports cancellation when the client aborts an in-flight model request', async () => {
    const { model, entered, aborted } = createPendingModel();
    const outcomes: ModelMediationOutcome[] = [];
    const lease = await openLocalModelAddress({
      call: MakaioBus.own('root'),
      model,
      credential: 'synthetic-authorization',
      signal: new AbortController().signal,
      requestTimeoutMs: 60_000,
      onOutcome: (outcome) => outcomes.push(outcome),
    });
    try {
      const client = new AbortController();
      const execution = adapter.start({ ...step, modelAddress: lease.address }, client.signal);
      expect(execution.start.success).toBe(true);
      await entered;
      client.abort();
      await expect(execution.turn).resolves.toEqual({ kind: 'cancelled' });
      expect(await aborted).not.toMatchObject({ name: 'TimeoutError' });
      await lease.close();
      expect(outcomes).toEqual([{ kind: 'cancelled' }]);
      await expect(fetch(lease.address, { method: 'POST' })).rejects.toThrow();
    } finally {
      await lease.close();
    }
  });

  it('reports cancellation and revokes the address when the worker aborts in flight', async () => {
    const worker = new AbortController();
    const { model, entered, aborted } = createPendingModel();
    const outcomes: ModelMediationOutcome[] = [];
    const lease = await openLocalModelAddress({
      call: MakaioBus.own('root'),
      model,
      credential: 'synthetic-authorization',
      signal: worker.signal,
      requestTimeoutMs: 60_000,
      onOutcome: (outcome) => outcomes.push(outcome),
    });
    try {
      const request = fetch(lease.address, { method: 'POST', body: reviewBody });
      const disconnected = expect(request).rejects.toThrow();
      await entered;
      worker.abort();
      await disconnected;
      expect(await aborted).not.toMatchObject({ name: 'TimeoutError' });
      await lease.close();
      expect(outcomes).toEqual([{ kind: 'cancelled' }]);
      await expect(fetch(lease.address, { method: 'POST' })).rejects.toThrow();
    } finally {
      await lease.close();
    }
  });

  it('reports cancellation when the client disconnects during a request body upload', async () => {
    const outcomes: ModelMediationOutcome[] = [];
    const reported = Promise.withResolvers<void>();
    const lease = await openLocalModelAddress({
      call: MakaioBus.own('root'),
      model: {
        modelId: 'stub',
        complete: async () => {
          throw new Error('Unexpected model request');
        },
      },
      credential: 'synthetic-authorization',
      signal: new AbortController().signal,
      requestTimeoutMs: 2000,
      onOutcome: (outcome) => {
        outcomes.push(outcome);
        reported.resolve();
      },
    });
    const upload = requestHttp(lease.address, {
      method: 'POST',
      headers: { expect: '100-continue', 'content-length': Buffer.byteLength(reviewBody) },
    });
    const continued = Promise.withResolvers<void>();
    upload.once('continue', () => continued.resolve());
    upload.once('error', continued.reject);
    try {
      upload.flushHeaders();
      await continued.promise;
      await new Promise<void>((resolve) => upload.write(reviewBody.slice(0, -1), () => resolve()));
      upload.destroy();
      await reported.promise;
      await lease.close();
      expect(outcomes).toEqual([{ kind: 'cancelled' }]);
    } finally {
      upload.destroy();
      await lease.close();
    }
  });

  it('reports a malformed HTTP 200 body as reply-invalid', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{');
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('Local test address unavailable');
      const modelAddress = exampleAddress.replace(':1/', `:${address.port}/`);
      const execution = adapter.start({ ...step, modelAddress }, new AbortController().signal);
      expect(execution.start.success).toBe(true);
      await expect(execution.turn).resolves.toEqual({ kind: 'failed', reason: 'reply-invalid' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
