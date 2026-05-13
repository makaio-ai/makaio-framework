/**
 * MakaioExtension descriptor for the Claude Code client.
 *
 * Wraps the existing {@link clientDefinition} in the standard
 * {@link MakaioExtension} shape so the runtime coordinator can discover and
 * register this client through the unified client contribution surface.
 */
import type { MakaioExtension } from '@makaio/contracts';
import { clientDefinition } from './definition.js';

/**
 * Package descriptor for the Claude Code client.
 *
 * Declares the Anthropic Claude Code CLI binary (`claude`) as a first-party
 * agentic coding assistant client with hook support and a default
 * `full-access` approval policy.
 */
export const claudeCodePackage: MakaioExtension = {
  name: 'claude-code',
  displayName: 'Claude Code',
  version: '0.1.0',
  clients: [clientDefinition],
};
