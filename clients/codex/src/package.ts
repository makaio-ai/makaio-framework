/**
 * MakaioExtension descriptor for the Codex client.
 *
 * Wraps the existing {@link clientDefinition} in the standard
 * {@link MakaioExtension} shape so the runtime coordinator can discover and
 * register this client through the unified client contribution surface.
 */
import type { MakaioExtension } from '@makaio/contracts';
import { clientDefinition } from './definition.js';

/**
 * Package descriptor for the Codex client.
 *
 * Declares the OpenAI Codex CLI binary (`codex`) as a first-party agentic
 * coding assistant client with hook and supervisor-launch support and a
 * default `full-access` approval policy.
 */
export const codexPackage: MakaioExtension = {
  name: 'codex',
  displayName: 'Codex',
  clients: [clientDefinition],
};
