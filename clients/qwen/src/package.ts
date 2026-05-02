/**
 * MakaioExtension descriptor for the Qwen Code client.
 *
 * Wraps the existing {@link clientDefinition} in the standard
 * {@link MakaioExtension} shape so the runtime coordinator can discover and
 * register this client through the unified client contribution surface.
 */
import type { MakaioExtension } from '@makaio/contracts';
import { clientDefinition } from './definition.js';

/**
 * Package descriptor for the Qwen Code client.
 *
 * Declares the Qwen Code CLI binary (`qwen`) as an agentic coding assistant
 * client using the Agent Client Protocol (ACP) for dynamic tool discovery
 * with an `always-ask` default approval policy.
 */
export const qwenPackage: MakaioExtension = {
  name: 'qwen',
  displayName: 'Qwen Code',
  clients: [clientDefinition],
};
