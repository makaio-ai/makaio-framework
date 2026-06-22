import type { IMakaioBus } from '@makaio/bus-core';
/**
 * MakaioNodeExtension<IMakaioBus> descriptor for the Claude Agent SDK adapter.
 *
 * Wraps the existing {@link adapterDefinition} in the standard
 * `MakaioNodeExtension<IMakaioBus>` shape so the runtime coordinator can discover and
 * register this adapter through the unified adapter contribution surface.
 */
import { dep } from '@makaio/contracts';
import type { MakaioNodeExtension } from '@makaio/contracts';
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
export const claudeAgentSdkPackage: MakaioNodeExtension<IMakaioBus> = {
  name: extensionName,
  displayName,
  version: '0.1.0',
  dependencies: [
    dep('provider-anthropic', undefined, true),
    dep('provider-z-ai', undefined, true),
    dep('provider-kimi', undefined, true),
    dep('provider-opencode-go', undefined, true),
  ],
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
