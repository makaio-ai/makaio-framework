import type { ProviderDefinitionInput } from '@makaio/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODEL_FETCH_TIMEOUT_MS } from '../constants.js';
import { fetchModels } from '../provider.fetcher.js';

function createFetchStub(
  implementation: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return Object.assign(implementation, { preconnect: vi.fn() });
}

const testDefinition = {
  id: 'openai',
  name: 'OpenAI',
  endpoints: { openai: 'https://example.test/v1' },
  credentialEnvVars: { apiKey: 'OPENAI_API_KEY' },
} satisfies ProviderDefinitionInput;

describe('openai-node provider fetcher', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('aborts live model discovery after the configured timeout', async () => {
    vi.useFakeTimers();
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');

    const captured: { signal?: AbortSignal } = {};
    vi.stubGlobal(
      'fetch',
      createFetchStub(async (_input, init) => {
        captured.signal = init?.signal ?? undefined;
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      }),
    );

    const result = fetchModels(testDefinition);
    const expectation = expect(result).rejects.toThrow(
      `OpenAI API request timed out after ${MODEL_FETCH_TIMEOUT_MS}ms`,
    );
    await vi.advanceTimersByTimeAsync(MODEL_FETCH_TIMEOUT_MS);

    await expectation;
    expect(captured.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
