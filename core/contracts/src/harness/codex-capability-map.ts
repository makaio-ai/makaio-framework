import type { ToolCapability } from '../tool-capability/index.js';

/**
 * Canonical capability map for Codex native harness tools.
 *
 * This is shared by contracts defaults and the codex-app-server adapter to
 * keep capability taxonomy in one place and avoid drift.
 */
export const codexCapabilityMap = {
  bash: ['shell.execute', 'file.read', 'file.write', 'file.delete', 'network.request', 'process.manage'],
  patch: ['file.write'],
} as const satisfies Record<string, readonly ToolCapability[]>;
