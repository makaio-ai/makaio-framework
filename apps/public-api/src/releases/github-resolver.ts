import {
  KNOWN_CHANNELS,
  type Channel,
  type ChannelInfo,
  type IReleaseResolver,
  type ResolvedAsset,
  type ResolvedRelease,
} from './types.js';
import { isUpdateJson, parseChannel } from './channels.js';

interface GitHubAsset {
  readonly name: string;
  readonly browser_download_url: string;
  readonly size: number;
}

interface GitHubRelease {
  readonly tag_name: string;
  readonly prerelease: boolean;
  readonly published_at: string;
  readonly assets: readonly GitHubAsset[];
}

/** Configuration for the GitHub-backed release resolver. */
export interface GitHubResolverConfig {
  /** GitHub repository in `owner/repo` format. */
  readonly repo: string;
  /** GitHub token for API access (avoids 60 req/hour unauthenticated rate limit). */
  readonly githubToken?: string;
  /** Cache TTL in milliseconds. Defaults to 60 000 (1 minute). */
  readonly cacheTtlMs?: number;
  /** Injectable fetch for testing. Defaults to `globalThis.fetch`. */
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

type ReleaseSelector = 'non-prerelease' | 'canary-prerelease';

/** Maps each channel to its release selector. `stable`/`cef` share a release; `canary`/`cef-canary` share another. */
const CHANNEL_SELECTORS: Record<Channel, ReleaseSelector> = {
  stable: 'non-prerelease',
  cef: 'non-prerelease',
  canary: 'canary-prerelease',
  'cef-canary': 'canary-prerelease',
};

const RELEASE_FILTERS: Record<ReleaseSelector, (r: GitHubRelease) => boolean> = {
  'non-prerelease': (r) => !r.prerelease,
  'canary-prerelease': (r) => r.prerelease && r.tag_name.includes('-canary.'),
};

/**
 * Resolves latest GitHub Releases per channel with TTL-based caching.
 *
 * Fetches the releases list once per TTL period (serving all channels from
 * the same response), then eagerly pre-fetches `*-update.json` asset contents
 * so they can be served inline without a redirect.
 *
 * Concurrent requests for the same data coalesce on a single inflight promise
 * to avoid thundering-herd duplication of outbound HTTP calls.
 */
export class GitHubReleaseResolver implements IReleaseResolver {
  private readonly repo: string;
  private readonly token: string | undefined;
  private readonly ttlMs: number;
  private readonly _fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

  private releasesCache: { releases: GitHubRelease[]; fetchedAt: number } | null = null;
  private inflightReleases: Promise<GitHubRelease[]> | null = null;

  /** Keyed by release tag — `stable`/`cef` share one entry; `canary`/`cef-canary` share another. */
  private resolvedCache = new Map<string, { release: ResolvedRelease; fetchedAt: number }>();
  private inflightResolves = new Map<string, Promise<ResolvedRelease>>();

  /**
   * Create a GitHub-backed release resolver.
   * @param config - Resolver configuration, including repository and optional fetch/cache overrides.
   */
  public constructor(config: GitHubResolverConfig) {
    this.repo = config.repo;
    this.token = config.githubToken;
    this.ttlMs = config.cacheTtlMs ?? 60_000;
    this._fetch = config.fetch ?? globalThis.fetch;
  }

  /**
   * Get the latest release for a channel.
   * @param channel - Release channel to resolve.
   * @returns The resolved release, or `null` if no matching release exists.
   */
  public async getLatestRelease(channel: Channel): Promise<ResolvedRelease | null> {
    const releases = await this.fetchReleasesList();
    const selector = CHANNEL_SELECTORS[channel];
    const filter = RELEASE_FILTERS[selector];

    const match = releases.find(
      (release) => filter(release) && release.assets.some((asset) => parseChannel(asset.name) === channel),
    );
    if (!match) return null;

    const tag = match.tag_name;
    const cached = this.resolvedCache.get(tag);
    if (cached && Date.now() - cached.fetchedAt < this.ttlMs) {
      return cached.release;
    }

    return this.resolveReleaseDeduped(tag, match);
  }

  /**
   * Get summary info for all known channels.
   * @returns Channel info objects (channels with no release are omitted).
   */
  public async getAllChannels(): Promise<ChannelInfo[]> {
    const entries = await Promise.all(
      KNOWN_CHANNELS.map(async (channel) => {
        const release = await this.getLatestRelease(channel);
        if (!release) return null;
        return { name: channel, version: release.version, updatedAt: release.publishedAt } as ChannelInfo;
      }),
    );
    return entries.filter((e): e is ChannelInfo => e !== null);
  }

  /**
   * Resolve and cache a GitHub release while coalescing concurrent requests for the same tag.
   * @param tag - Git tag used as the resolved-release cache key.
   * @param gh - GitHub release payload to resolve.
   * @returns Resolved release metadata and assets.
   */
  private async resolveReleaseDeduped(tag: string, gh: GitHubRelease): Promise<ResolvedRelease> {
    const inflight = this.inflightResolves.get(tag);
    if (inflight) return inflight;

    const promise = this.resolveRelease(gh)
      .then((resolved) => {
        this.resolvedCache.set(tag, { release: resolved, fetchedAt: Date.now() });
        return resolved;
      })
      .finally(() => {
        this.inflightResolves.delete(tag);
      });
    this.inflightResolves.set(tag, promise);
    return promise;
  }

  /**
   * Fetch the GitHub releases list, reusing cached or inflight list requests when possible.
   * @returns GitHub release payloads ordered by the upstream API.
   */
  private async fetchReleasesList(): Promise<GitHubRelease[]> {
    if (this.releasesCache && Date.now() - this.releasesCache.fetchedAt < this.ttlMs) {
      return this.releasesCache.releases;
    }
    if (this.inflightReleases) return this.inflightReleases;

    const promise = this.fetchReleasesFromGitHub();
    this.inflightReleases = promise;
    return promise;
  }

  /**
   * Load the releases list directly from GitHub and refresh the list cache.
   * @returns GitHub release payloads from the configured repository.
   */
  private async fetchReleasesFromGitHub(): Promise<GitHubRelease[]> {
    try {
      const url = `https://api.github.com/repos/${this.repo}/releases?per_page=30`;
      const response = await this._fetch(url, {
        headers: this.buildHeaders({ Accept: 'application/vnd.github+json' }),
      });
      if (!response.ok) {
        throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
      }

      const releases = (await response.json()) as GitHubRelease[];
      this.releasesCache = { releases, fetchedAt: Date.now() };
      return releases;
    } finally {
      this.inflightReleases = null;
    }
  }

  /**
   * Convert a GitHub release payload into the API's resolved release representation.
   *
   * If a `*-update.json` content fetch fails (e.g. transient 5xx), the asset is
   * stored without `content` so the route handler falls back to a redirect rather
   * than propagating the error and dropping the entire release.
   * @param gh - GitHub release payload to convert.
   * @returns Resolved release metadata with update JSON assets prefetched where possible.
   */
  private async resolveRelease(gh: GitHubRelease): Promise<ResolvedRelease> {
    const assets = new Map<string, ResolvedAsset>();

    await Promise.all(
      gh.assets.map(async (asset) => {
        if (isUpdateJson(asset.name)) {
          try {
            const content = await this.fetchAssetContent(asset.browser_download_url);
            assets.set(asset.name, { url: asset.browser_download_url, size: asset.size, content });
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            console.warn(`[resolver] Failed to pre-fetch ${asset.name}, falling back to redirect: ${reason}`);
            assets.set(asset.name, { url: asset.browser_download_url, size: asset.size });
          }
        } else {
          assets.set(asset.name, { url: asset.browser_download_url, size: asset.size });
        }
      }),
    );

    return {
      tag: gh.tag_name,
      version: gh.tag_name.replace(/^v/, ''),
      publishedAt: gh.published_at,
      assets,
    };
  }

  /**
   * Fetch and parse an update JSON asset.
   * @param url - GitHub asset download URL.
   * @returns Parsed update JSON content.
   */
  private async fetchAssetContent(url: string): Promise<Record<string, unknown>> {
    const response = await this._fetch(url, { headers: this.buildHeaders() });
    if (!response.ok) {
      throw new Error(`Failed to fetch asset content: ${response.status}`);
    }
    return response.json();
  }

  /**
   * Build GitHub request headers with the optional bearer token.
   * @param extra - Headers to merge with the default GitHub API headers.
   * @returns Headers for a GitHub API or asset request.
   */
  private buildHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { 'User-Agent': 'makaio-release-api', ...extra };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    return headers;
  }
}
