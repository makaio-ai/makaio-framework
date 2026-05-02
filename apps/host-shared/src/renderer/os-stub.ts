import type { NetworkInterfaceInfo } from 'node:os';

/**
 * Browser stub for Node's os module.
 */
export interface OsStub {
  /** Browser-friendly OS type identifier. */
  type: () => string;
  /** Browser-friendly platform identifier. */
  platform: () => string;
  /** Browser-safe home directory path. */
  homedir: () => string;
  /** Browser-safe temporary directory path. */
  tmpdir: () => string;
  /** Browser-safe empty network interface map. */
  networkInterfaces: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
  /** Browser-safe end-of-line marker. */
  EOL: string;
  /** Browser stub for os.constants. */
  constants: typeof constants;
}

/**
 * Browser stub for Node's os module.
 * @returns Browser-friendly OS type identifier.
 */
export function type(): string {
  return 'Browser';
}

/**
 * @returns Browser-friendly platform identifier.
 */
export function platform(): string {
  return 'browser';
}

/**
 * @returns Browser-safe home directory path.
 */
export function homedir(): string {
  return '/';
}

/**
 * @returns Browser-safe temporary directory path.
 */
export function tmpdir(): string {
  return '/tmp';
}

/**
 * Browser-safe network interface listing.
 * @returns Empty interface map because browser context has no host NIC access.
 */
export function networkInterfaces(): NodeJS.Dict<NetworkInterfaceInfo[]> {
  return {};
}

/**
 * Browser-safe end-of-line marker.
 */
export const EOL = '\n';

/**
 * Browser stub for Node's os.constants.
 * Provides empty sub-objects so named imports don't crash at resolution time.
 */
export const constants = {
  UV_UDP_REUSEADDR: 0,
  dlopen: {} as Record<string, number>,
  errno: {} as Record<string, number>,
  signals: {} as Record<string, number>,
  priority: {} as Record<string, number>,
};

/**
 * Browser-friendly os surface used by Vite aliases and browser tests.
 */
const osStub: OsStub = { type, platform, homedir, tmpdir, networkInterfaces, EOL, constants };
export default osStub;
