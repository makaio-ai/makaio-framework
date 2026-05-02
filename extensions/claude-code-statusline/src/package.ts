import type { MakaioExtension } from '@makaio/contracts';
import { claudeCodeStatuslineCli } from './cli/contribution.js';

/**
 * Optional package that wires the Claude statusline CLI command into the
 * runtime without coupling to usage ingestion yet.
 */
export const claudeCodeStatuslinePackage: MakaioExtension = {
  name: 'claude-code-statusline',
  displayName: 'Claude Code Statusline',
  cli: claudeCodeStatuslineCli,
};
