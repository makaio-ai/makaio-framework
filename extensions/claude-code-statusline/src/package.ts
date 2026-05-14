import type { IMakaioBus } from '@makaio/bus-core';
import type { MakaioNodeExtension } from '@makaio/contracts';
import { claudeCodeStatuslineCli } from './cli/contribution.js';

/**
 * Optional package that wires the Claude statusline CLI command into the
 * runtime without coupling to usage ingestion yet.
 */
export const claudeCodeStatuslinePackage: MakaioNodeExtension<IMakaioBus> = {
  name: 'claude-code-statusline',
  displayName: 'Claude Code Statusline',
  version: '0.1.0',
  cli: claudeCodeStatuslineCli,
};
