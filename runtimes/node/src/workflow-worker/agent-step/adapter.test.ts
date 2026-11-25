import { createServer, request as requestHttp } from 'node:http';
import { MakaioBus } from '@makaio/bus-core';
import { describe, expect, it } from 'vitest';
import { closeHttpServer, listenOnLoopback } from '../../__tests__/http-test-helpers.js';
import { createHttpWorkerModelPort } from './http-model-port.js';
import {
  openLocalModelAddress,
  type ModelCredentialSource,
  type ModelMediationOutcome,
  type WorkerModelPort,
} from './model-mediator.js';
import { AgentStepCapabilitiesSchema, MODEL_MESSAGE_LIMIT_BYTES, type ModelFailureCode } from './protocol.js';
import { createTextAgentStepAdapter } from './text-adapter.js';

const adapter = createTextAgentStepAdapter('text-model', 'worker-instance');
const step = {
  request: {
    adapterId: 'text-model',
    role: 'member',
    model: 'stub',
    initialMessage: 'check the change',
    responseSchema: { schema: { type: 'object', required: ['approved'] } },
  },
  auth: { kind: 'none' },
};

const exampleAddress = 'http://127.0.0.1:1/model/00000000-0000-0000-0000-000000000000';
const reviewBody = JSON.stringify({ model: 'stub', prompt: 'review' });
const target = 'model-upstream';
const credentialSource: ModelCredentialSource = {
  request: async () => ({ kind: 'issued', credential: 'synthetic-authorization' }),
};

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
  it('completes a structured turn through a named upstream and the same credential source after refresh', async () => {
    const call = MakaioBus.own('root');
    const signal = new AbortController().signal;
    const resolvedReasons: string[] = [];
    const upstreamCalls: Array<{ authorization: string | undefined; body: string }> = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        if (Buffer.isBuffer(chunk)) chunks.push(chunk);
      }
      const authorization = request.headers.authorization;
      upstreamCalls.push({ authorization, body: Buffer.concat(chunks).toString() });
      const code = authorization === 'Bearer fixture-renewed-token' ? 200 : 401;
      response.writeHead(code, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ text: '{"approved":true}', irrelevant: 'fixture-renewed-token' }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Local test address unavailable');
    const model = createHttpWorkerModelPort('stub', {
      name: target,
      url: new URL(`http://127.0.0.1:${address.port}/model`),
    });
    const lease = await openLocalModelAddress({
      call,
      model,
      credentialSource: {
        request: async (received, input) => {
          expect(received).toBe(call);
          expect(input).toMatchObject({ purpose: 'model.use', target });
          resolvedReasons.push(input.reason);
          return {
            kind: 'issued',
            credential: input.reason === 'refresh' ? 'fixture-renewed-token' : 'fixture-expired-token',
          };
        },
      },
      target,
      signal,
      requestTimeoutMs: 2000,
    });
    try {
      const capabilities = AgentStepCapabilitiesSchema.parse(adapter.capabilities);
      expect(capabilities.capabilities).toContain('structuredOutput');
      expect(capabilities.environment).toEqual([{ name: 'MAKAIO_MODEL_ADDRESS', source: 'makaio.model-address' }]);
      const execution = adapter.start({ ...step, modelAddress: lease.address }, signal);
      expect(execution.start).toMatchObject({ success: true, adapterId: 'text-model' });
      await expect(execution.turn).resolves.toEqual({ kind: 'completed', result: { output: { approved: true } } });
      expect(resolvedReasons).toEqual(['initial', 'refresh']);
      expect(upstreamCalls.map(({ authorization }) => authorization)).toEqual([
        'Bearer fixture-expired-token',
        'Bearer fixture-renewed-token',
      ]);
      expect(upstreamCalls[0]?.body).toContain('check the change');
      expect(upstreamCalls[0]?.body).toContain('approved');
      expect(upstreamCalls[1]?.body).toBe(upstreamCalls[0]?.body);
    } finally {
      await lease.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('runs a large structured turn within the existing model message budget', async () => {
    const signal = new AbortController().signal;
    const output = { approved: true, explanation: 'é'.repeat(20_000) };
    const lease = await openLocalModelAddress({
      call: MakaioBus.own('root'),
      model: {
        modelId: 'stub',
        complete: async ({ request }) => {
          expect(request.prompt).toContain('policy 💡');
          expect(request.prompt).toContain('schema 💡');
          return { kind: 'completed', reply: { text: JSON.stringify(output) } };
        },
      },
      credentialSource,
      target,
      signal,
      requestTimeoutMs: 2000,
    });
    try {
      const request = {
        ...step.request,
        initialMessage: 'policy 💡'.repeat(3_000),
        responseSchema: { schema: { type: 'object', description: 'schema 💡'.repeat(2_000) } },
      };
      const execution = adapter.start({ ...step, request, modelAddress: lease.address }, signal);
      await expect(execution.turn).resolves.toEqual({ kind: 'completed', result: { output } });
    } finally {
      await lease.close();
    }
  });

  it('refuses a model turn without the credential purpose before making an upstream request', async () => {
    const signal = new AbortController().signal;
    const lease = await openLocalModelAddress({
      call: MakaioBus.own('root'),
      model: createHttpWorkerModelPort('stub', { name: target, url: new URL('http://127.0.0.1:1') }),
      credentialSource: { request: async () => ({ kind: 'purpose-not-granted' }) },
      target,
      signal,
      requestTimeoutMs: 2000,
    });
    try {
      const execution = adapter.start({ ...step, modelAddress: lease.address }, signal);
      await expect(execution.turn).resolves.toEqual({ kind: 'failed', reason: 'environmentMissing' });
    } finally {
      await lease.close();
    }
  });

  it.each([
    'streamed',
    'announced',
  ] as const)('rejects an oversized reply (%s) without waiting for its end', async (kind) => {
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      if (kind === 'announced') {
        response.setHeader('content-length', MODEL_MESSAGE_LIMIT_BYTES + 1);
      }
      response.write(kind === 'announced' ? ' ' : ' '.repeat(MODEL_MESSAGE_LIMIT_BYTES + 1));
    });
    const port = await listenOnLoopback(server);
    const signal = new AbortController().signal;
    const lease = await openLocalModelAddress({
      call: MakaioBus.own('root'),
      model: createHttpWorkerModelPort('stub', { name: target, url: new URL(`http://127.0.0.1:${port}`) }),
      credentialSource,
      target,
      signal,
      requestTimeoutMs: 2000,
    });
    try {
      const execution = adapter.start({ ...step, modelAddress: lease.address }, signal);
      await expect(execution.turn).resolves.toEqual({ kind: 'failed', reason: 'reply-invalid' });
    } finally {
      await lease.close();
      server.closeAllConnections();
      await closeHttpServer(server);
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
      credentialSource,
      target,
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
        [JSON.stringify({ model: 'stub', prompt: 'é'.repeat(MODEL_MESSAGE_LIMIT_BYTES / 2) }), 'request-too-large'],
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
    [
      'missing response schema',
      { ...step, request: { ...step.request, responseSchema: undefined }, modelAddress: exampleAddress },
    ],
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
      credentialSource,
      target,
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
      credentialSource,
      target,
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
      credentialSource,
      target,
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
      credentialSource,
      target,
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
      credentialSource,
      target,
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

  it.each([
    ['{', 'reply-invalid'],
    [JSON.stringify({ text: 'sensitive upstream prose' }), 'output-invalid'],
  ])('rejects malformed model reply %s', async (body, reason) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' }).end(body);
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
      await expect(execution.turn).resolves.toEqual({ kind: 'failed', reason });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
