import type { WindowRegistration } from '@makaio/kernel';

/** Runtime configuration needed by the shared renderer bootstrap. */
export interface RendererLaunchConfig {
  /** HTTP URL of the renderer document. */
  readonly baseUrl: string;
  /** WebSocket URL of the host bus. */
  readonly busUrl: string;
  /** Package name owning the window registration. */
  readonly packageName: string;
  /** Qualified window registration id. */
  readonly windowId: string;
  /** Window-specific context params. */
  readonly params: Readonly<Record<string, string>>;
  /** Whether service boot has completed before this window was created. */
  readonly bootComplete: boolean;
}

/** Options for {@link createRendererLaunchConfig}. */
export interface CreateRendererLaunchConfigOptions {
  /** Renderer base URL. */
  readonly baseUrl: string;
  /** Bus WebSocket URL. */
  readonly busUrl: string;
  /** Window registration selected by the host. */
  readonly registration: Pick<WindowRegistration, 'packageName' | 'qualifiedId'>;
  /** Window-specific context params. */
  readonly params?: Readonly<Record<string, string>>;
  /** Whether service boot has completed before this window was created. */
  readonly bootComplete: boolean;
}

/** Options for serializing renderer launch config into a URL. */
export interface BuildRendererLaunchUrlOptions {
  /** Include `busUrl` in the query string. */
  readonly includeBusUrl?: boolean;
  /** Include `bootComplete` in the query string. */
  readonly includeBootComplete?: boolean;
}

const RESERVED_RENDERER_QUERY_KEYS: ReadonlySet<string> = new Set(['app', 'window', 'busUrl', 'bootComplete']);

/**
 * Build the host-neutral renderer launch config for a window registration.
 * @param options - Launch config inputs.
 * @returns Normalized renderer launch config.
 */
export function createRendererLaunchConfig(options: CreateRendererLaunchConfigOptions): RendererLaunchConfig {
  return {
    baseUrl: options.baseUrl,
    busUrl: options.busUrl,
    packageName: options.registration.packageName,
    windowId: options.registration.qualifiedId,
    params: options.params ?? {},
    bootComplete: options.bootComplete,
  };
}

/**
 * Serialize a renderer launch config into the SPA URL shape used by both
 * desktop hosts.
 * @param config - Renderer launch config.
 * @param options - Serialization options.
 * @returns Fully constructed renderer URL.
 */
export function buildRendererLaunchUrl(
  config: RendererLaunchConfig,
  options: BuildRendererLaunchUrlOptions = {},
): string {
  const url = new URL(config.baseUrl);
  url.pathname = url.pathname.replace(/\/$/, '') || '/';
  url.searchParams.set('app', config.packageName);
  url.searchParams.set('window', config.windowId);

  if (options.includeBusUrl === true) {
    url.searchParams.set('busUrl', config.busUrl);
  }
  if (options.includeBootComplete === true) {
    url.searchParams.set('bootComplete', config.bootComplete ? '1' : '0');
  }

  for (const [key, value] of Object.entries(config.params)) {
    if (RESERVED_RENDERER_QUERY_KEYS.has(key)) {
      throw new Error(`[renderer-launch-config] Reserved query key "${key}" cannot be set via params.`);
    }
    url.searchParams.set(key, value);
  }

  return url.toString();
}

/**
 * Encode renderer params for transports that cannot pass structured values.
 * @param params - Window-specific context params.
 * @returns Percent-encoded JSON object string.
 */
export function encodeRendererParams(params: Readonly<Record<string, string>>): string {
  return encodeURIComponent(JSON.stringify(params));
}
