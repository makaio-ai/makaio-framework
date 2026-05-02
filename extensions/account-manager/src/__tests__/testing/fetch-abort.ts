import { vi } from 'vitest';

/**
 * Mocks fetch so aborting the provided signal rejects with AbortError.
 *
 * Shared by timeout tests to keep their fake-timer harness identical across
 * sources that use the same AbortController deadline pattern.
 */
export function mockFetchAbortOnSignal(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
  );
}
