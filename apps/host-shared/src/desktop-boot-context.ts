import * as os from 'node:os';
import * as path from 'node:path';

/** Default user data directory name for stable desktop hosts. */
export const DEFAULT_DESKTOP_MAKAIO_HOME_DIR = '.makaio';

/** Environment key used by desktop hosts to select the runtime data home. */
export const DESKTOP_MAKAIO_HOME_ENV = 'MAKAIO_HOME';

/** Options for resolving the desktop runtime data home. */
export interface ResolveDesktopMakaioHomeOptions {
  /** Environment snapshot to read. */
  readonly env?: NodeJS.ProcessEnv;
  /** Default directory name or absolute path used when `MAKAIO_HOME` is unset. */
  readonly defaultDir?: string;
  /** User home directory used for relative defaults. */
  readonly homeDir?: string;
}

/** Options for applying the resolved runtime data home to an environment object. */
export interface ApplyDesktopMakaioHomeEnvOptions extends ResolveDesktopMakaioHomeOptions {
  /** Mutable environment object that receives the normalized `MAKAIO_HOME`. */
  readonly env: NodeJS.ProcessEnv;
}

/** Host-owned boot metadata shared by desktop composition roots. */
export interface DesktopBootContext {
  /** Absolute runtime data home passed to runtime boot and config loading. */
  readonly makaioHome: string;
  /** Optional framework version used when package metadata is unavailable at runtime. */
  readonly frameworkVersion?: string;
  /** Optional bundled `@makaio/framework` package root. */
  readonly frameworkPackagePath?: string;
  /** Optional fallback seed files for the model registry. */
  readonly modelRegistryFallbackSeedPaths?: readonly string[];
}

/** Options for constructing {@link DesktopBootContext}. */
export interface CreateDesktopBootContextOptions extends ResolveDesktopMakaioHomeOptions {
  /** Optional framework version used when package metadata is unavailable at runtime. */
  readonly frameworkVersion?: string;
  /** Optional bundled `@makaio/framework` package root. */
  readonly frameworkPackagePath?: string;
  /** Optional fallback seed files for the model registry. */
  readonly modelRegistryFallbackSeedPaths?: readonly string[];
}

/**
 * Resolve a desktop host's runtime data home.
 *
 * `MAKAIO_HOME` remains the operational override. When it is absent, the host
 * default is resolved relative to the user's home unless it is already absolute.
 * @param options - Resolution inputs.
 * @returns Absolute runtime data home.
 */
export function resolveDesktopMakaioHome(options: ResolveDesktopMakaioHomeOptions = {}): string {
  const env = options.env ?? process.env;
  const declared = env[DESKTOP_MAKAIO_HOME_ENV]?.trim();
  if (declared && declared.length > 0) {
    return path.resolve(declared);
  }

  const defaultDir = options.defaultDir ?? DEFAULT_DESKTOP_MAKAIO_HOME_DIR;
  if (path.isAbsolute(defaultDir)) {
    return defaultDir;
  }

  return path.resolve(options.homeDir ?? os.homedir(), defaultDir);
}

/**
 * Resolve and write the normalized runtime data home into a host environment.
 *
 * Some runtime code still reads `process.env.MAKAIO_HOME` directly; desktop
 * composition roots call this once before boot so every layer observes the same
 * absolute path.
 * @param options - Environment and resolution inputs.
 * @returns Absolute runtime data home written to `env.MAKAIO_HOME`.
 */
export function applyDesktopMakaioHomeEnv(options: ApplyDesktopMakaioHomeEnvOptions): string {
  const resolved = resolveDesktopMakaioHome(options);
  options.env[DESKTOP_MAKAIO_HOME_ENV] = resolved;
  return resolved;
}

/**
 * Construct shared desktop boot metadata.
 * @param options - Desktop boot context inputs.
 * @returns Host-neutral boot metadata.
 */
export function createDesktopBootContext(options: CreateDesktopBootContextOptions = {}): DesktopBootContext {
  return {
    makaioHome: resolveDesktopMakaioHome(options),
    ...(options.frameworkVersion !== undefined ? { frameworkVersion: options.frameworkVersion } : {}),
    ...(options.frameworkPackagePath !== undefined ? { frameworkPackagePath: options.frameworkPackagePath } : {}),
    ...(options.modelRegistryFallbackSeedPaths !== undefined
      ? { modelRegistryFallbackSeedPaths: options.modelRegistryFallbackSeedPaths }
      : {}),
  };
}
