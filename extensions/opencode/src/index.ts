/**
 * OpenCode Package.
 *
 * Provides log import capability for OpenCode AI coding tool.
 * This is the first package to use the logImport capability,
 * demonstrating how packages can contribute log importers without
 * requiring a full adapter implementation.
 *
 * Schema verified against OpenCode v1.1.x logs (2026-01-22).
 * @packageDocumentation
 */

import type { MakaioExtension } from '@makaio/contracts';
import { OpenCodeLogImporter } from './importer.js';

/**
 * OpenCode package descriptor.
 *
 * Declares log import capability for OpenCode.
 * No storage, triggers, tools, or UI — just log import.
 */
export const opencodePackage: MakaioExtension = {
  name: 'opencode',
  displayName: 'OpenCode',

  /**
   * Log import capability.
   *
   * Registers the OpenCode log importer with the unified LogImportRegistry.
   * The runtime processor narrows `config` to `PluginLogImport` at processing
   * time and will:
   * 1. Instantiate OpenCodeLogImporter with plugin metadata
   * 2. Register the importer for auto-detection and manual import
   * 3. Enable file watching for incremental import
   */
  logImport: {
    adapterName: 'plugin:opencode',
    displayName: 'OpenCode',
    config: {
      LogImporterClass: OpenCodeLogImporter,
      // Matches all JSON files in session subdirectories: storage/session/*/*.json
      // Valid session files are filtered via OpenCodeMessageSchema/OpenCodePartSchema validation
      logFilePattern: '**/storage/session/*/*.json',
    },
  },
};

// Default exports stay on the MakaioExtension contract.
export default opencodePackage;

// Public API exports
export { OpenCodeLogImporter } from './importer.js';
export type {
  OpenCodeSession,
  OpenCodeMessage,
  OpenCodeSessionLog,
  OpenCodeImportState,
  OpenCodeLogImporterConfig,
} from './types.js';
