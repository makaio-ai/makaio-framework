import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveVariantConfig, type VariantConfig } from '../variant-config.js';

export interface DetectVariantOptions {
  /** Whether the host is running in development/unbundled mode. */
  readonly isDev?: boolean;
  /** Environment used for development fallback resolution. */
  readonly env?: NodeJS.ProcessEnv;
  /** Executable path used to locate the bundled Resources directory. */
  readonly execPath?: string;
}

/**
 * Detect the active build variant for this Electrobun host instance.
 *
 * Resolution order:
 * 1. Production: reads `variant.json` placed in the macOS app bundle's
 *    `Contents/Resources/` directory by the build pipeline.
 * 2. Dev / fallback: reads the `MAKAIO_VARIANT` environment variable via
 *    {@link resolveVariantConfig}, defaulting to `'base'`/`'stable'` when unset.
 * @param options - Optional process inputs for tests and host boot wiring.
 * @returns The resolved {@link VariantConfig} for the running host.
 */
export function detectVariant(options: DetectVariantOptions = {}): VariantConfig {
  const isDev = options.isDev ?? process.env['NODE_ENV'] !== 'production';
  const env = options.env ?? process.env;
  const execPath = options.execPath ?? process.execPath;
  const resourcesDir = path.join(path.dirname(execPath), '..', 'Resources');
  const variantPath = path.join(resourcesDir, 'variant.json');
  if (fs.existsSync(variantPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(variantPath, 'utf-8')) as { variant?: string; releaseTrack?: string };
      return resolveVariantConfig(raw.variant, raw.releaseTrack);
    } catch (err: unknown) {
      if (!isDev) {
        throw new Error(`Failed to parse bundled variant descriptor at ${variantPath}`, { cause: err });
      }
      console.warn('[electrobun] Failed to parse variant.json, falling back to env:', err);
    }
  }

  if (!isDev) {
    throw new Error(`Missing bundled variant descriptor at ${variantPath}`);
  }
  return resolveVariantConfig(env['MAKAIO_VARIANT'], env['MAKAIO_RELEASE_TRACK']);
}
