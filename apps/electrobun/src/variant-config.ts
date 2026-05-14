/**
 * Re-export the canonical variant identifier type from contracts.
 *
 * `import type` is erased at runtime, so this does not trigger the bus
 * namespace registration side-effect in contracts - safe for build scripts.
 */
export type { MakaioVariant } from '@makaio/contracts/variant';
import type { MakaioVariant } from '@makaio/contracts/variant';

/** Release track selected at package time. */
export type ReleaseTrack = 'stable' | 'canary';

/**
 * Valid Electrobun build environment values.
 *
 * Electrobun's CLI only accepts `dev`, `canary`, and `stable`. Any other value
 * silently falls back to `dev`, producing a dev-named app bundle. Our variant
 * (base/cef) is orthogonal to the build environment and is separated via
 * `buildFolder` / `artifactFolder` instead.
 */
export type ElectrobunBuildEnv = 'dev' | 'canary' | 'stable';

/**
 * Resolved configuration for a specific build variant.
 *
 * All properties are readonly - variant config is determined at build time
 * and must not be mutated at runtime.
 */
export interface VariantConfig {
  /** The resolved variant identifier. */
  readonly variant: MakaioVariant;
  /** Release track selected for this packaged build. */
  readonly releaseTrack: ReleaseTrack;
  /** Valid Electrobun `--env` value derived from the release track. */
  readonly electrobunBuildEnv: ElectrobunBuildEnv;
  /** Whether to bundle the Chromium Embedded Framework into the distributable. */
  readonly bundleCEF: boolean;
  /** Default renderer backend selected when no explicit override is provided. */
  readonly defaultRenderer: 'native' | 'cef';
  /** Electrobun `build.buildFolder` — separates variant/track outputs. */
  readonly buildFolder: string;
  /** Electrobun `build.artifactFolder` — separates variant/track artifacts. */
  readonly artifactFolder: string;
}

/** Renderer backend fields consumed by `electrobun.config.ts`. */
export interface VariantRendererConfig {
  /** Whether the Chromium Embedded Framework is bundled into the distributable. */
  readonly bundleCEF: boolean;
  /** Renderer backend selected by Electrobun when no runtime override is provided. */
  readonly defaultRenderer: 'native' | 'cef';
}

const VARIANTS: Record<MakaioVariant, Pick<VariantConfig, 'bundleCEF' | 'defaultRenderer'>> = {
  base: { bundleCEF: false, defaultRenderer: 'native' },
  cef: { bundleCEF: true, defaultRenderer: 'cef' },
};

/**
 * Release-server channel identifier used by the upgrade handler.
 *
 * This is NOT an Electrobun build environment — it is a release-server concept
 * that routes the Electrobun updater to the correct variant artifact set.
 * The upgrade handler rewrites `version.json`'s `channel` field to this value
 * so the updater fetches `{baseUrl}/{releaseChannel}-{os}-{arch}-update.json`.
 */
export type ReleaseChannel = 'stable' | 'cef' | 'canary' | 'cef-canary';

const RELEASE_CHANNELS: Record<ReleaseTrack, Record<MakaioVariant, ReleaseChannel>> = {
  stable: { base: 'stable', cef: 'cef' },
  canary: { base: 'canary', cef: 'cef-canary' },
};

/**
 * Resolve the release-server channel for a variant and release track.
 *
 * Used by the upgrade handler to rewrite `version.json` so the Electrobun
 * updater fetches the correct variant's artifacts from the release server.
 * @param variant - Host variant identifier.
 * @param releaseTrack - Release track for the packaged app.
 * @returns Release channel string written to `version.json`.
 */
export function resolveVariantReleaseChannel(
  variant: MakaioVariant,
  releaseTrack: ReleaseTrack = 'stable',
): ReleaseChannel {
  return RELEASE_CHANNELS[releaseTrack][variant];
}

/** Maps release track to the valid Electrobun `--env` value. */
const RELEASE_TRACK_TO_BUILD_ENV: Record<ReleaseTrack, ElectrobunBuildEnv> = {
  stable: 'stable',
  canary: 'canary',
};

/**
 * Resolve the valid Electrobun build environment for a release track.
 * @param releaseTrack - Release track for the packaged app.
 * @returns Electrobun `--env` value (`stable` or `canary`).
 */
export function resolveElectrobunBuildEnv(releaseTrack: ReleaseTrack): ElectrobunBuildEnv {
  return RELEASE_TRACK_TO_BUILD_ENV[releaseTrack];
}

/**
 * Resolves the build variant and release track from package-time env vars.
 *
 * Defaults to `'base'` variant and `'stable'` release track when unset.
 *
 * Electrobun only accepts `dev | canary | stable` as `--env` values; anything
 * else silently falls back to `dev`. Our variant dimension (base/cef) is
 * separated via per-variant `buildFolder` and `artifactFolder` paths instead.
 * @param variantEnv - Raw value of `process.env.MAKAIO_VARIANT`, or `undefined`.
 * @param releaseTrackEnv - Raw value of `process.env.MAKAIO_RELEASE_TRACK`, or `undefined`.
 * @returns The fully resolved {@link VariantConfig} for the requested variant and track.
 * @throws Error when the supplied variant or release track is not known.
 */
export function resolveVariantConfig(
  variantEnv: string | undefined,
  releaseTrackEnv?: string | undefined,
): VariantConfig {
  const variant: MakaioVariant = variantEnv ? (variantEnv as MakaioVariant) : 'base';
  if (!Object.hasOwn(VARIANTS, variant)) {
    throw new Error(`Unknown variant "${variant}". Valid: ${Object.keys(VARIANTS).join(', ')}`);
  }

  const releaseTrack: ReleaseTrack = releaseTrackEnv ? (releaseTrackEnv as ReleaseTrack) : 'stable';
  if (!Object.hasOwn(RELEASE_TRACK_TO_BUILD_ENV, releaseTrack)) {
    throw new Error(
      `Unknown release track "${releaseTrackEnv}". Valid: ${Object.keys(RELEASE_TRACK_TO_BUILD_ENV).join(', ')}`,
    );
  }

  const electrobunBuildEnv = resolveElectrobunBuildEnv(releaseTrack);
  const folderSuffix = `${variant}-${releaseTrack}`;

  return {
    variant,
    releaseTrack,
    electrobunBuildEnv,
    buildFolder: `build/${folderSuffix}`,
    artifactFolder: `artifacts/${folderSuffix}`,
    ...VARIANTS[variant],
  };
}

/**
 * Resolve the Electrobun renderer backend fields for a variant.
 *
 * Kept in production code so tests assert the same mapping consumed by
 * `electrobun.config.ts` instead of duplicating config derivation locally.
 * @param config - Fully resolved variant configuration.
 * @returns Renderer backend configuration for Electrobun platform targets.
 */
export function resolveVariantRendererConfig(config: VariantConfig): VariantRendererConfig {
  return {
    bundleCEF: config.bundleCEF,
    defaultRenderer: config.defaultRenderer,
  };
}
