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

/** Electrobun update channel used in `version.json` and release artifact names. */
export type UpdateChannel = 'stable' | 'cef' | 'canary' | 'cef-canary';

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
  /** Electrobun update channel that carries artifacts for this variant. */
  readonly updateChannel: UpdateChannel;
  /** Whether to bundle the Chromium Embedded Framework into the distributable. */
  readonly bundleCEF: boolean;
  /** Default renderer backend selected when no explicit override is provided. */
  readonly defaultRenderer: 'native' | 'cef';
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

const UPDATE_CHANNELS: Record<ReleaseTrack, Record<MakaioVariant, UpdateChannel>> = {
  stable: {
    base: 'stable',
    cef: 'cef',
  },
  canary: {
    base: 'canary',
    cef: 'cef-canary',
  },
};

/**
 * Resolve the Electrobun update channel that carries a variant.
 *
 * The public host variant is `base`, but Electrobun's `stable` build
 * environment is the only channel that preserves the production app name
 * (`Makaio.app`) instead of producing `Makaio-base.app`.
 * @param variant - Host variant identifier.
 * @param releaseTrack - Release track for the packaged app.
 * @returns Electrobun update channel used by version.json and release artifacts.
 */
export function resolveVariantUpdateChannel(
  variant: MakaioVariant,
  releaseTrack: ReleaseTrack = 'stable',
): UpdateChannel {
  return UPDATE_CHANNELS[releaseTrack][variant];
}

/**
 * Resolves the build variant and release track from package-time env vars.
 *
 * Defaults to `'base'` (no CEF, system WebView) when unset or empty.
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
  if (!Object.hasOwn(UPDATE_CHANNELS, releaseTrack)) {
    throw new Error(`Unknown release track "${releaseTrack}". Valid: ${Object.keys(UPDATE_CHANNELS).join(', ')}`);
  }

  return {
    variant,
    releaseTrack,
    updateChannel: resolveVariantUpdateChannel(variant, releaseTrack),
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
