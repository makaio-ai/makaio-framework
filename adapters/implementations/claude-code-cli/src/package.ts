/**
 * MakaioExtension descriptor for the Claude Code CLI adapter.
 *
 * Wraps the existing {@link adapterDefinition} in the standard
 * {@link MakaioExtension} shape so the runtime coordinator can discover and
 * register this adapter through the unified adapter contribution surface.
 */
import type { MakaioExtension } from '@makaio/contracts';
import { adapterDefinition } from './definition.js';
import { ClaudeCodeCliAdapterName } from './constants.js';

const displayName = adapterDefinition.displayName ?? adapterDefinition.name;
const description = adapterDefinition.description ?? displayName;
const clients = adapterDefinition.clients;

/**
 * Package descriptor for the Claude Code CLI adapter.
 *
 * Runs the `claude` binary over stdio JSON streaming. Declares the `anthropic`
 * wire protocol — the same as the SDK adapter — since both target the
 * Anthropic API via different transports.
 */
export const claudeCodeCliPackage: MakaioExtension = {
  name: ClaudeCodeCliAdapterName,
  displayName,
  dependencies: ['provider-anthropic'],
  adapters: [
    {
      manifest: {
        name: ClaudeCodeCliAdapterName,
        displayName,
        description,
        ...(clients ? { clients } : {}),
        protocols: ['anthropic'],
      },
      definition: adapterDefinition,
    },
  ],
};

export default claudeCodeCliPackage;
