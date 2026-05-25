/**
 * Known release channels served by this API.
 *
 * Order matters: longer prefixes first so `parseChannel` doesn't false-match
 * `cef-canary-*` as `cef`.
 */
export const KNOWN_CHANNELS = ['cef-canary', 'canary', 'stable', 'cef'] as const;

/** A release channel identifier. */
export type Channel = (typeof KNOWN_CHANNELS)[number];

/** A resolved artifact from a GitHub Release. */
export interface ResolvedAsset {
  /** GitHub browser_download_url for this asset. */
  readonly url: string;
  /** Asset size in bytes. */
  readonly size: number;
  /** Pre-fetched content for update.json files. `undefined` for non-JSON assets. */
  readonly content?: Record<string, unknown>;
}

/** A resolved GitHub Release for a specific channel. */
export interface ResolvedRelease {
  /** Git tag (e.g. `v0.1.0`, `v0.1.0-canary.3`). */
  readonly tag: string;
  /** Semver version without `v` prefix. */
  readonly version: string;
  /** ISO 8601 publish timestamp. */
  readonly publishedAt: string;
  /** Map of asset filename to resolved asset metadata. */
  readonly assets: ReadonlyMap<string, ResolvedAsset>;
}

/** Channel summary returned by the `/channels` endpoint. */
export interface ChannelInfo {
  readonly name: Channel;
  readonly version: string;
  readonly updatedAt: string;
}

/**
 * Resolves the latest release for a given channel.
 *
 * Implementations handle caching, source-specific API calls, and
 * update.json content pre-fetching internally.
 */
export interface IReleaseResolver {
  /**
   * Get the latest release for a channel.
   * @param channel - Release channel to resolve.
   * @returns The resolved release, or `null` if no matching release exists.
   */
  getLatestRelease(channel: Channel): Promise<ResolvedRelease | null>;

  /**
   * Get summary info for all known channels.
   * @returns Array of channel info objects (channels with no release are omitted).
   */
  getAllChannels(): Promise<ChannelInfo[]>;
}
