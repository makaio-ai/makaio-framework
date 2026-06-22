import type { IMakaioBus } from '@makaio/bus-core';
/**
 * MakaioNodeExtension<IMakaioBus> descriptor for the Codex App-Server adapter.
 *
 * Wraps the existing {@link adapterDefinition} in the standard
 * `MakaioNodeExtension<IMakaioBus>` shape so the runtime coordinator can discover and
 * register this adapter through the unified adapter contribution surface.
 */
import { dep } from '@makaio/contracts';
import type { MakaioNodeExtension } from '@makaio/contracts';
import { adapterDefinition } from './definition.js';
import { CodexAppServerAdapterName } from './constants.js';

const clients = adapterDefinition.clients;

/**
 * Package descriptor for the Codex App-Server adapter.
 *
 * Spawns a `codex app-server` subprocess and communicates via stdin/stdout
 * using JSON-RPC 2.0 over JSONL. Declares the `openai` wire protocol since
 * Codex surfaces an OpenAI-compatible API.
 */
export const codexAppServerPackage: MakaioNodeExtension<IMakaioBus> = {
  name: CodexAppServerAdapterName,
  displayName: 'Codex App-Server',
  version: '0.1.0',
  dependencies: [dep('provider-openai-codex', undefined, true)],
  adapters: [
    {
      manifest: {
        name: CodexAppServerAdapterName,
        displayName: 'Codex App-Server',
        description: 'Direct integration with codex app-server via stdio subprocess using JSON-RPC 2.0 over JSONL',
        ...(clients ? { clients } : {}),
        protocols: ['openai'],
      },
      definition: adapterDefinition,
    },
  ],
};

export default codexAppServerPackage;
