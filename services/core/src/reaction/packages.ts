import type { IMakaioBus } from '@makaio/bus-core';
import type { MakaioNodeExtension } from '@makaio/contracts';
import { extensionToken } from '@makaio/contracts';
import { ReactionRegistry } from './reaction-registry.js';

/** Token for the Reaction registry service. */
export const ReactionRegistryToken = extensionToken<ReactionRegistry>('reaction-registry');

/** Package that starts the framework Reaction registry. */
export const reactionRegistryPackage: MakaioNodeExtension<IMakaioBus> = {
  name: ReactionRegistryToken.name,
  displayName: 'Reaction Registry',
  version: '0.1.0',
  critical: true,
  create: (ctx) => new ReactionRegistry(ctx.bus),
};
