/**
 * MakaioExtension descriptor for the Claude Code tmux adapter.
 *
 * Wraps the existing {@link adapterDefinition} in the standard
 * {@link MakaioExtension} shape so the runtime coordinator can discover and
 * register this adapter through the unified adapter contribution surface.
 */
import { dep } from '@makaio/contracts';
import type { MakaioExtension } from '@makaio/contracts';
import { adapterDefinition } from './definition.js';
import { ADAPTER_NAME } from './constants.js';

const displayName = adapterDefinition.displayName ?? adapterDefinition.name;
const description = adapterDefinition.description ?? displayName;
const clients = adapterDefinition.clients;

/**
 * Package descriptor for the Claude Code tmux adapter.
 *
 * Runs Claude Code interactively in a tmux session. Declares the `anthropic`
 * wire protocol — the same as the CLI and SDK adapters — since all three
 * target the Anthropic API via different transports.
 */
export const claudeCodeTmuxPackage: MakaioExtension = {
  name: ADAPTER_NAME,
  displayName,
  version: '0.1.0',
  dependencies: [dep('provider-anthropic'), dep('claude-code'), dep('client-hooks'), dep('claude-code-statusline')],
  adapters: [
    {
      manifest: {
        name: ADAPTER_NAME,
        displayName,
        description,
        ...(clients ? { clients } : {}),
        protocols: ['anthropic'],
      },
      definition: adapterDefinition,
    },
  ],
};

export default claudeCodeTmuxPackage;
