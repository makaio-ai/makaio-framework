import type { MakaioExtension } from '@makaio/contracts/extension';
import { filesystemToolset } from './toolset.js';

/**
 * Filesystem tool extension.
 *
 * Contributes the `filesystem` toolset to the runtime `ToolRegistry` while
 * keeping filesystem helper APIs available for composition roots and tests.
 */
export const filesystemPackage: MakaioExtension = {
  name: 'filesystem',
  displayName: 'Filesystem Tools',
  surface: 'headless',
  tools: {
    /**
     * Create filesystem toolsets.
     * @returns Filesystem toolset contribution.
     */
    createToolsets: () => [filesystemToolset],
  },
};

export default filesystemPackage;

export { filesystemToolset } from './toolset.js';
export { type FileAccessRules, type FileAccessRuleProvider, FILE_ACCESS_RULES_KEY } from './types.js';
export { DEFAULT_DENIED_PATTERNS, createMakaioIgnoreProvider } from './ignore/index.js';
export { extractToolFilePath } from './tool-path-extractor.js';
