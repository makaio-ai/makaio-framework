/**
 * Browser-side extension contribution types.
 *
 * Defines the contract returned by an extension's browser entry point factory.
 * Each extension's browser bundle exports a default {@link ExtensionBrowserFactory}
 * that the loader calls once per page load to collect UI contributions.
 * @packageDocumentation
 */

import type { IMakaioBus } from '@makaio/bus-core';
import type { WidgetDefinition } from '../widgets/types.js';
import type { PageDeclaration } from '../pages/types.js';
import type { PageDefinition } from '../pages/page-definition-types.js';
import type { ComponentLike } from '../utils/component-types.js';

// ---------------------------------------------------------------------------
// Shell contribution
// ---------------------------------------------------------------------------

/**
 * Props passed to the shell's root layout component.
 */
export interface ShellProps {
  /** Bus instance for handler registration and event emission. */
  bus: IMakaioBus;
}

/**
 * Shell contribution — provides the workspace chrome.
 *
 * An extension that supplies this takes over the root layout of the renderer.
 * Only one extension should provide a shell; if multiple do, last-wins.
 */
export interface ShellContribution {
  /**
   * Root layout component — replaces the shell's content area entirely.
   * Receives {@link ShellProps} from the host renderer.
   */
  component: ComponentLike<ShellProps>;
}

// ---------------------------------------------------------------------------
// Extension browser contribution
// ---------------------------------------------------------------------------

/**
 * Returned by an extension's browser entry point factory.
 *
 * Every field is optional; an extension declares only the surfaces it contributes.
 * The browser loader merges contributions from all loaded extensions in load order.
 */
export interface ExtensionBrowserContribution {
  /**
   * Workspace chrome — the root layout component.
   *
   * Only one extension should provide this. If multiple do, last-wins.
   * The framework loader renders its own fallback shell when no extension
   * provides workspace chrome.
   */
  shell?: ShellContribution;

  /** Slot-based page layout declarations registered into {@link pageRegistry}. */
  pages?: PageDeclaration[];

  /** Navigable page definitions registered into {@link pageDefinitionRegistry}. */
  pageDefinitions?: PageDefinition[];

  /** Standard widget contributions. */
  widgets?: readonly WidgetDefinition[];

  /** Called on extension unload to release browser-side resources. */
  destroy?: () => void;
}

// ---------------------------------------------------------------------------
// Factory type
// ---------------------------------------------------------------------------

/**
 * Runtime context passed to an extension browser factory.
 */
export interface ExtensionBrowserFactoryContext {
  /** Browser bus instance owned by the loader surface. */
  bus: IMakaioBus;
}

/**
 * Browser entry point shape — the default export of extension browser bundles.
 *
 * The browser loader calls this factory once per page load to obtain the
 * extension's UI contributions.
 * @param context - Runtime context supplied by the browser loader.
 * @returns Browser UI contribution for this extension.
 */
export type ExtensionBrowserFactory = (context: ExtensionBrowserFactoryContext) => ExtensionBrowserContribution;
