import type { IAutoLaunchProvider } from '@makaio/contracts';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const APP_BUNDLE_MARKER = '.app/Contents/';

/**
 * Reverse-DNS label used as the LaunchAgent plist filename.
 *
 * The plist is written to `~/Library/LaunchAgents/<LABEL>.plist`.
 */
const LAUNCH_AGENT_LABEL = 'ai.makaio.app';

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
 * Build the absolute path to the LaunchAgent plist file.
 * @param label - The reverse-DNS label for the LaunchAgent.
 * @returns Absolute path to `~/Library/LaunchAgents/<label>.plist`.
 */
function launchAgentPlistPath(label: string): string {
  return path.join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
}

/**
 * Build the XML plist content for a LaunchAgent that opens the app at login.
 * @param label - The reverse-DNS label identifying the agent.
 * @param appPath - Absolute path to the `.app` bundle.
 * @param hidden - Whether to start the app hidden (background / no windows).
 * @returns A well-formed XML plist string.
 */
function buildPlistContent(label: string, appPath: string, hidden: boolean): string {
  const programArgs = hidden
    ? `    <array>
      <string>/usr/bin/open</string>
      <string>-jga</string>
      <string>${escapeXml(appPath)}</string>
    </array>`
    : `    <array>
      <string>/usr/bin/open</string>
      <string>-a</string>
      <string>${escapeXml(appPath)}</string>
    </array>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
${programArgs}
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`;
}

/**
 * Escape special XML characters in a string value.
 * @param value - Raw string to escape.
 * @returns XML-safe string.
 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * macOS auto-launch provider using a LaunchAgent plist.
 *
 * Writes a plist to `~/Library/LaunchAgents/` and uses `launchctl` to
 * load/unload it. This approach requires no special permissions —
 * unlike the previous System Events AppleScript approach which
 * triggered an Accessibility permission dialog.
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
   *
   * Writes a LaunchAgent plist and loads it via `launchctl`.
   * @param hidden - Whether the app should start hidden (tray only).
   * @returns Whether auto-launch was successfully enabled.
   */
  public async enable(hidden = true): Promise<{ enabled: boolean; error?: string }> {
    try {
      const plistPath = launchAgentPlistPath(LAUNCH_AGENT_LABEL);
      const plistContent = buildPlistContent(LAUNCH_AGENT_LABEL, this.appPath, hidden);

      // Ensure the LaunchAgents directory exists.
      await mkdir(path.dirname(plistPath), { recursive: true });

      // Bootout any previously loaded agent before overwriting the plist.
      // Errors are ignored — the agent may not be loaded yet.
      await this.tryBootout();

      await writeFile(plistPath, plistContent, 'utf-8');
      await execFileAsync('launchctl', ['load', '-w', plistPath]);

      return { enabled: true };
    } catch (err) {
      return { enabled: false, error: errorMessage(err) };
    }
  }

  /**
   * Disable auto-launch at login.
   *
   * Unloads the LaunchAgent and removes the plist file.
   * @returns Whether auto-launch was successfully disabled.
   */
  public async disable(): Promise<{ disabled: boolean; error?: string }> {
    try {
      const plistPath = launchAgentPlistPath(LAUNCH_AGENT_LABEL);

      // Bootout the agent — ignore errors if it was never loaded.
      await this.tryBootout();

      // Remove the plist file. ENOENT is silently accepted.
      await rm(plistPath, { force: true });

      return { disabled: true };
    } catch (err) {
      return { disabled: false, error: errorMessage(err) };
    }
  }

  /**
   * Query current auto-launch status.
   *
   * Checks whether the plist file exists and contains the current app path.
   * @returns Whether auto-launch is enabled and supported.
   */
  public async getStatus(): Promise<{
    enabled: boolean;
    supported: boolean;
    error?: string;
  }> {
    try {
      const plistPath = launchAgentPlistPath(LAUNCH_AGENT_LABEL);
      const content = await readFile(plistPath, 'utf-8');
      const enabled = content.includes(this.appPath);
      return { enabled, supported: true };
    } catch (err) {
      // ENOENT means no plist — auto-launch is simply not configured.
      if (isNodeError(err) && err.code === 'ENOENT') {
        return { enabled: false, supported: true };
      }
      return { enabled: false, supported: true, error: errorMessage(err) };
    }
  }

  /**
   * Attempt to bootout a loaded LaunchAgent. Failures are silently ignored.
   */
  private async tryBootout(): Promise<void> {
    try {
      const uid = process.getuid?.() ?? 501;
      await execFileAsync('launchctl', ['bootout', `gui/${String(uid)}/${LAUNCH_AGENT_LABEL}`]);
    } catch {
      // Agent may not be loaded — this is expected.
    }
  }
}

/**
 * Type guard for Node.js system errors with a `code` property.
 * @param err - The caught error.
 * @returns Whether the error has a string `code` property.
 */
function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}
