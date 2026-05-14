import type { IMakaioBus } from '@makaio/bus-core';
/**
 * MakaioNodeExtension<IMakaioBus> descriptor for the Codex client.
 *
 * Wraps the existing {@link clientDefinition} in the standard
 * `MakaioNodeExtension<IMakaioBus>` shape so the runtime coordinator can discover and
 * register this client through the unified client contribution surface.
 */
import type { MakaioNodeExtension } from '@makaio/contracts';
import { clientDefinition } from './definition.js';

/**
 * Package descriptor for the Codex client.
 *
 * Declares the OpenAI Codex CLI binary (`codex`) as a first-party agentic
 * coding assistant client with hook and supervisor-launch support and a
 * default `full-access` approval policy.
 */
export const codexPackage: MakaioNodeExtension<IMakaioBus> = {
  name: 'codex',
  displayName: 'Codex',
  version: '0.1.0',
  clients: [clientDefinition],
};
