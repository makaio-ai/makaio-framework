/**
 * MakaioExtension descriptor for the Claude Agent SDK adapter.
 *
 * Wraps the existing {@link adapterDefinition} in the standard
 * {@link MakaioExtension} shape so the runtime coordinator can discover and
 * register this adapter through the unified adapter contribution surface.
 */
import type { MakaioExtension } from '@makaio/contracts';
import { adapterDefinition } from './definition.js';
import { ClaudeCodeAdapterName } from './constants.js';

const extensionName = 'claude-agent-sdk';
const displayName = adapterDefinition.displayName ?? adapterDefinition.name;
const description = adapterDefinition.description ?? displayName;
const clients = adapterDefinition.clients;

/**
 * Package descriptor for the Claude Agent SDK adapter.
 *
 * Delegates to the Claude Agent SDK for agentic interactions. Declares the
 * `anthropic` wire protocol, compatible with Anthropic-hosted and
 * proxy-compatible endpoints.
 */
export const claudeAgentSdkPackage: MakaioExtension = {
  name: extensionName,
  displayName,
  dependencies: ['provider-anthropic', 'provider-z-ai', 'provider-kimi'],
  adapters: [
    {
      manifest: {
        name: ClaudeCodeAdapterName,
        displayName,
        description,
        ...(clients ? { clients } : {}),
        protocols: ['anthropic'],
      },
      definition: adapterDefinition,
    },
  ],
};

export default claudeAgentSdkPackage;
