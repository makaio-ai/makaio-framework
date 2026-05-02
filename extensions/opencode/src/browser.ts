/**
 * OpenCode Package - Browser Entry Point
 *
 * The OpenCode package is server-only (log import uses Node.js fs).
 * This browser entry point exports a no-op browser contribution factory.
 * @packageDocumentation
 */

import type { ExtensionBrowserFactory } from '@makaio/ui-kernel';

/**
 * OpenCode browser contribution factory.
 *
 * Server-only extension; provides no browser UI surfaces.
 * @returns Empty browser contribution object.
 */
export const opencodeBrowserContribution: ExtensionBrowserFactory = () => ({});

export default opencodeBrowserContribution;

// Type exports only - no runtime exports
export type {
  OpenCodeSession,
  OpenCodeMessage,
  OpenCodeSessionLog,
  OpenCodeImportState,
  OpenCodeLogImporterConfig,
} from './types.js';
