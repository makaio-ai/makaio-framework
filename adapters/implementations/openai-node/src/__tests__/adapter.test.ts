import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIAdapter } from '../adapter.js';
import { MODEL_FETCH_TIMEOUT_MS } from '../constants.js';

function createFetchStub(
  implementation: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return Object.assign(implementation, { preconnect: vi.fn() });
}

describe('OpenAIAdapter.fetchModels', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('passes an abort signal and normalizes successful responses', async () => {
    let capturedSignal: AbortSignal | null = null;
    const fetchStub = createFetchStub(async (_input, init) => {
      capturedSignal = init?.signal ?? null;
      return new Response(JSON.stringify({ data: [{ name: 'name-only-model', context_length: 4096 }] }), {
        status: 200,
      });
    });
    vi.stubGlobal('fetch', fetchStub);

    const models = await new OpenAIAdapter().fetchModels('https://example.test/v1', { apiKey: 'sk-test' });

    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(models).toMatchObject([{ name: 'name-only-model', friendlyName: 'name-only-model' }]);
  });

  it('aborts model discovery after the configured timeout', async () => {
    vi.useFakeTimers();
    const fetchStub = createFetchStub(async (_input, init) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    });
    vi.stubGlobal('fetch', fetchStub);

    const result = new OpenAIAdapter().fetchModels('https://example.test/v1', { apiKey: 'sk-test' });
    const expectation = expect(result).rejects.toThrow(`timed out after ${MODEL_FETCH_TIMEOUT_MS}ms`);
    await vi.advanceTimersByTimeAsync(MODEL_FETCH_TIMEOUT_MS);

    await expectation;
  });

  it('clears the timeout after HTTP failures', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      createFetchStub(async () => new Response('', { status: 500, statusText: 'Server Error' })),
    );

    await expect(new OpenAIAdapter().fetchModels('https://example.test/v1', { apiKey: 'sk-test' })).rejects.toThrow(
      /500 Server Error/,
    );

    expect(vi.getTimerCount()).toBe(0);
  });
});
