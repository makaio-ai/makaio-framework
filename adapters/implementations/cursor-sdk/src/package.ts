/**
 * MakaioNodeExtension descriptor for the Cursor SDK adapter.
 *
 * Wraps the existing {@link adapterDefinition} in the standard
 * `MakaioNodeExtension<IMakaioBus>` shape so the runtime coordinator can discover
 * and register this adapter through the unified adapter contribution surface.
 */
import type { IMakaioBus } from '@makaio/bus-core';
import { dep } from '@makaio/contracts';
import type { MakaioNodeExtension } from '@makaio/contracts';
import { adapterDefinition } from './definition.js';
import { CursorSdkAdapterName } from './constants.js';
import { providerIds } from './provider.js';

const clients = adapterDefinition.clients;

/**
 * Package descriptor for the Cursor SDK adapter.
 *
 * Communicates with the Cursor AI editor via its proprietary SDK, which manages
 * its own agentic loop internally. Declares the `cursor` provider as its sole
 * upstream dependency since Cursor uses a custom authentication layer that does
 * not map to a standard Makaio wire protocol.
 */
export const cursorSdkPackage: MakaioNodeExtension<IMakaioBus> = {
  name: CursorSdkAdapterName,
  displayName: 'Cursor SDK',
  version: '0.1.0',
  dependencies: providerIds.map((definitionId) => dep(`provider-${definitionId}`)),
  adapters: [
    {
      manifest: {
        name: CursorSdkAdapterName,
        displayName: 'Cursor SDK',
        description: 'Cursor AI editor agent via TypeScript SDK',
        ...(clients ? { clients } : {}),
        protocols: [],
      },
      definition: adapterDefinition,
    },
  ],
};

export default cursorSdkPackage;
