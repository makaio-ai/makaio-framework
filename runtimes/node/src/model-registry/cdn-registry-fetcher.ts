import { parse as parseYaml } from 'yaml';
import { ModelRegistrySchema } from '@makaio/services-core/model-registry';
import type { IModelRegistryFetcher, ModelRegistry } from '@makaio/services-core/model-registry';

const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

/**
 * Fetches the model registry from a remote CDN URL that returns YAML.
 *
 * Validates the response against {@link ModelRegistrySchema} before returning.
 * Throws a descriptive error on HTTP failures or parse errors so the wrapping
 * {@link FallbackRegistryFetcher} can advance to the next source.
 * @example
 * ```typescript
 * const fetcher = new CdnRegistryFetcher('https://example.com/model-registry.yaml');
 * const registry = await fetcher.fetch();
 * ```
 */
export class CdnRegistryFetcher implements IModelRegistryFetcher {
  private readonly url: string;
  private readonly timeoutMs: number;

  /**
   * Creates a new CdnRegistryFetcher.
   * @param url - Non-empty URL to the YAML model registry.
   * @param timeoutMs - Request timeout in milliseconds.
   */
  public constructor(url: string, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      throw new Error('CdnRegistryFetcher requires a non-empty registry URL');
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(trimmedUrl);
    } catch (error) {
      throw new Error(`CdnRegistryFetcher requires a valid registry URL: ${trimmedUrl}`, { cause: error });
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error(`CdnRegistryFetcher requires an HTTP(S) registry URL: ${trimmedUrl}`);
    }

    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`CdnRegistryFetcher requires a positive finite timeoutMs, got ${timeoutMs}`);
    }

    this.url = parsedUrl.toString();
    this.timeoutMs = timeoutMs;
  }

  /**
   * Fetch and parse the YAML model registry from the CDN URL.
   * @returns Validated model registry
   * @throws Error if the request fails, times out, or schema validation fails
   */
  public async fetch(): Promise<ModelRegistry> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(this.url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`Failed to fetch model registry: ${response.status} ${response.statusText}`);
      }
      const text = await response.text();
      const parsed: unknown = parseYaml(text);
      return ModelRegistrySchema.parse(parsed);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Failed to fetch model registry: timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
