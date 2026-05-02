import type { IAutoLaunchProvider } from '@makaio/contracts';
import path from 'node:path';

const APP_BUNDLE_MARKER = '.app/Contents/';

/** Target macOS app bundle for Login Item management. */
export interface MacOSAutoLaunchProviderOptions {
  /** Human-readable Login Item name as shown by System Events. */
  readonly appName: string;
  /** Absolute path to the `.app` bundle registered as a Login Item. */
  readonly appPath: string;
}

/** Inputs for resolving the current host's auto-launch target. */
export interface ResolveMacOSAutoLaunchTargetOptions {
  /** Environment snapshot used for explicit app bundle overrides. */
  readonly env: NodeJS.ProcessEnv;
  /** Current process executable path. */
  readonly execPath: string;
}

/**
 * Extract a human-readable message from an unknown caught value.
 * @param err - The caught error or value.
 * @returns A string suitable for error reporting.
 */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Escape a string for safe interpolation into AppleScript double-quoted literals.
 * @param value - The raw string value.
 * @returns The escaped string.
 */
function escapeAppleScript(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Lazily resolved `runAppleScript` function — cached after first import. */
let cachedRunAppleScript: ((script: string) => Promise<string>) | undefined;

/**
 * Get the `runAppleScript` function, importing the module on first call.
 * @returns The `runAppleScript` function from `run-applescript`.
 */
async function getRunAppleScript(): Promise<(script: string) => Promise<string>> {
  if (!cachedRunAppleScript) {
    const mod = await import('run-applescript');
    cachedRunAppleScript = mod.runAppleScript;
  }
  return cachedRunAppleScript;
}

/**
 * Derive the Login Item name from a macOS app bundle path.
 * @param appPath - Absolute path to the `.app` bundle.
 * @returns The bundle basename without the `.app` suffix.
 */
function deriveAppName(appPath: string): string {
  return path.posix.basename(appPath, '.app');
}

/**
 * Resolve an auto-launch target from explicit host policy or the running app bundle.
 *
 * `MAKAIO_APP` is an explicit launcher override. When absent, packaged desktop
 * hosts are identified from `process.execPath`; headless `makaio serve` boots do
 * not run from an app bundle and therefore do not register this capability.
 * @param options - Environment and executable path used for resolution.
 * @returns Provider options when a macOS app bundle is known.
 */
export function resolveMacOSAutoLaunchTarget(
  options: ResolveMacOSAutoLaunchTargetOptions,
): MacOSAutoLaunchProviderOptions | undefined {
  const declaredPath = options.env['MAKAIO_APP']?.trim();
  const appPath =
    declaredPath && declaredPath.length > 0 ? declaredPath : resolveRunningAppBundlePath(options.execPath);
  if (!appPath) return undefined;

  return {
    appName: deriveAppName(appPath),
    appPath,
  };
}

/**
 * Extract the containing `.app` bundle path from a packaged macOS executable.
 * @param execPath - Current process executable path.
 * @returns The containing `.app` bundle path when present.
 */
function resolveRunningAppBundlePath(execPath: string): string | undefined {
  const markerIndex = execPath.indexOf(APP_BUNDLE_MARKER);
  if (markerIndex === -1) return undefined;
  return execPath.slice(0, markerIndex + '.app'.length);
}

/**
 * macOS auto-launch provider using Login Items via AppleScript.
 *
 * Uses `System Events` to manage Login Items — the same mechanism
 * as right-clicking the Dock icon and selecting "Open at Login".
 */
export class MacOSAutoLaunchProvider implements IAutoLaunchProvider {
  public readonly id = 'macos-auto-launch';
  public readonly displayName = 'macOS Login Item';
  public readonly capabilityId = 'autoLaunch' as const;

  private readonly appName: string;
  private readonly appPath: string;

  /**
   * @param options - Login Item identity and target bundle path.
   */
  public constructor(options: MacOSAutoLaunchProviderOptions) {
    this.appName = options.appName;
    this.appPath = options.appPath;
  }

  /**
   * Enable auto-launch at login.
   * @param hidden - Whether the app should start hidden (tray only).
   * @returns Whether auto-launch was successfully enabled.
   */
  public async enable(hidden = true): Promise<{ enabled: boolean; error?: string }> {
    try {
      const runAppleScript = await getRunAppleScript();
      const path = escapeAppleScript(this.appPath);
      await runAppleScript(
        `tell application "System Events" to make login item at end with properties {path:"${path}", hidden:${String(hidden)}}`,
      );
      return { enabled: true };
    } catch (err) {
      return { enabled: false, error: errorMessage(err) };
    }
  }

  /**
   * Disable auto-launch at login.
   * @returns Whether auto-launch was successfully disabled.
   */
  public async disable(): Promise<{ disabled: boolean; error?: string }> {
    try {
      const runAppleScript = await getRunAppleScript();
      const name = escapeAppleScript(this.appName);
      await runAppleScript(`tell application "System Events" to delete login item "${name}"`);
      return { disabled: true };
    } catch (err) {
      return { disabled: false, error: errorMessage(err) };
    }
  }

  /**
   * Query current auto-launch status.
   * @returns Whether auto-launch is enabled and supported.
   */
  public async getStatus(): Promise<{ enabled: boolean; supported: boolean; error?: string }> {
    try {
      const runAppleScript = await getRunAppleScript();
      const result = await runAppleScript('tell application "System Events" to get the name of every login item');
      const items = result.split(', ');
      return { enabled: items.includes(this.appName), supported: true };
    } catch (err) {
      return { enabled: false, supported: true, error: errorMessage(err) };
    }
  }
}
