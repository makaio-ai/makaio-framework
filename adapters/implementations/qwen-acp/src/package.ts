import type { IMakaioBus } from '@makaio/bus-core';
/**
 * MakaioNodeExtension<IMakaioBus> descriptor for the Qwen ACP adapter.
 *
 * Wraps the existing {@link adapterDefinition} in the standard
 * `MakaioNodeExtension<IMakaioBus>` shape so the runtime coordinator can discover and
 * register this adapter through the unified adapter contribution surface.
 */
import type { MakaioNodeExtension } from '@makaio/contracts';
import { QwenAcpAdapterName } from './constants.js';

/**
 * Package descriptor for the Qwen ACP adapter.
 *
 * Communicates with the Qwen Code CLI over stdio via the Agent Client
 * Protocol (ACP). The CLI owns its upstream provider protocol, so the adapter
 * does not claim an HTTP wire protocol.
 */
export const qwenAcpPackage: MakaioNodeExtension<IMakaioBus> = {
  name: QwenAcpAdapterName,
  displayName: 'Qwen Code (ACP)',
  version: '0.1.0',
};

export default qwenAcpPackage;
