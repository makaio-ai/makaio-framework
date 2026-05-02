/**
 * Style presets for window types.
 *
 * Each style provides sensible defaults for window dimensions and behavior.
 * Package manifests declare a style, then optionally override individual fields.
 */
export type WindowStyle = 'tray-popover' | 'utility' | 'panel';

/**
 * A registered window entry with resolved configuration.
 *
 * Combines manifest-declared values with style preset defaults.
 * Used by Electron's WindowManager to create and configure windows.
 */
export interface WindowRegistration {
  /** Qualified window ID: `{packageName}:{windowId}`. */
  readonly qualifiedId: string;
  /** Package that owns this window. */
  readonly packageName: string;
  /** Window ID within the package. */
  readonly windowId: string;
  /** Display name (from package manifest). */
  readonly displayName: string;
  /** Window style preset. */
  readonly style: WindowStyle;
  /** Window width in pixels. */
  readonly width: number;
  /** Window height in pixels. */
  readonly height: number;
  /** Whether the window appears in the dock/taskbar. */
  readonly showInDock: boolean;
  /** Whether the window dismisses when losing focus. */
  readonly dismissOnBlur: boolean;
  /** Whether the window has a native frame. */
  readonly frame: boolean;
  /** Whether only one instance of this window can exist. */
  readonly singleton: boolean;
  /** Named route parameters declared by the manifest. */
  readonly params?: readonly import('@makaio/contracts').WindowParamSpec[];
}

/**
 * Default values for each window style.
 *
 * These are applied as base values; manifest-declared fields override them.
 */
export const STYLE_DEFAULTS: Record<
  WindowStyle,
  Omit<WindowRegistration, 'qualifiedId' | 'packageName' | 'windowId' | 'displayName' | 'style'>
> = {
  'tray-popover': {
    width: 400,
    height: 500,
    showInDock: false,
    dismissOnBlur: true,
    frame: false,
    singleton: true,
  },
  utility: {
    width: 900,
    height: 700,
    showInDock: true,
    dismissOnBlur: false,
    frame: true,
    singleton: false,
  },
  panel: {
    width: 400,
    height: 800,
    showInDock: true,
    dismissOnBlur: false,
    frame: true,
    singleton: false,
  },
};

/**
 * Input shape matching WindowManifest from contracts.
 *
 * This local interface mirrors the `WindowManifest` interface that will be
 * introduced in `@makaio/contracts` during Track 5. Using a local type avoids
 * a cross-track dependency during early development; the import will be
 * swapped in once contracts are stable.
 */
interface WindowManifestInput {
  /** Window ID within the package. */
  readonly id: string;
  /** Window style preset. */
  readonly style: WindowStyle;
  /** Window width in pixels (overrides style default). */
  readonly width?: number;
  /** Window height in pixels (overrides style default). */
  readonly height?: number;
  /** Whether only one instance can exist (overrides style default). */
  readonly singleton?: boolean;
  /** Named route parameters this window accepts. */
  readonly params?: readonly { readonly name: string; readonly required?: boolean }[];
}

/**
 * Dynamic registry of window configurations populated from package manifests.
 *
 * Replaces the static `WindowType` enum and `WINDOW_TYPE_CONFIG` table.
 * Packages register windows during boot via the ExtensionCoordinator.
 * Electron's WindowManager queries this registry to create windows.
 */
export class WindowRegistry {
  private readonly entries = new Map<string, WindowRegistration>();

  /**
   * Register a window from a package manifest.
   *
   * Style defaults are applied first; manifest-declared fields override them.
   * @param packageName - Owning package name.
   * @param displayName - Package display name.
   * @param window - Window manifest from the package.
   * @returns The created {@link WindowRegistration}.
   * @throws If the qualified ID is already registered.
   */
  public register(packageName: string, displayName: string, window: WindowManifestInput): WindowRegistration {
    const qualifiedId = `${packageName}:${window.id}`;
    if (this.entries.has(qualifiedId)) {
      throw new Error(`WindowRegistry: duplicate window ID "${qualifiedId}"`);
    }
    const defaults = STYLE_DEFAULTS[window.style];
    const registration: WindowRegistration = {
      qualifiedId,
      packageName,
      windowId: window.id,
      displayName,
      style: window.style,
      width: window.width ?? defaults.width,
      height: window.height ?? defaults.height,
      showInDock: defaults.showInDock,
      dismissOnBlur: defaults.dismissOnBlur,
      frame: defaults.frame,
      singleton: window.singleton ?? defaults.singleton,
      ...(window.params && { params: window.params }),
    };
    this.entries.set(qualifiedId, registration);
    return registration;
  }

  /**
   * Look up a window registration by qualified ID.
   * @param qualifiedId - The `{packageName}:{windowId}` identifier.
   * @returns The registration, or `undefined` if not found.
   */
  public get(qualifiedId: string): WindowRegistration | undefined {
    return this.entries.get(qualifiedId);
  }

  /**
   * Find a window registration by package name and window ID.
   *
   * Useful for tray entries that reference `opensWindow` by window ID
   * within the same package.
   * @param packageName - Package name to search.
   * @param windowId - Window ID within the package.
   * @returns The registration, or `undefined` if not found.
   */
  public getByPackageWindow(packageName: string, windowId: string): WindowRegistration | undefined {
    return this.entries.get(`${packageName}:${windowId}`);
  }

  /**
   * Remove all windows registered by a package.
   *
   * Used during extension cleanup when a package fails, is disabled, or
   * shuts down.
   * @param packageName - Package name whose windows to remove.
   */
  public unregisterPackage(packageName: string): void {
    const toRemove: string[] = [];
    for (const [id, reg] of this.entries) {
      if (reg.packageName === packageName) {
        toRemove.push(id);
      }
    }
    for (const id of toRemove) {
      this.entries.delete(id);
    }
  }

  /**
   * List all registered windows.
   * @returns Array of all window registrations.
   */
  public list(): ReadonlyArray<WindowRegistration> {
    return [...this.entries.values()];
  }

  /**
   * Number of registered windows.
   * @returns The count of registered window entries.
   */
  public get size(): number {
    return this.entries.size;
  }
}
