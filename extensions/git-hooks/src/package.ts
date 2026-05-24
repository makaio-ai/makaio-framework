/**
 * Package manifest for the git-hooks extension.
 *
 * Registers the native Git hook installation surface under `makaio git-hooks`
 * and exposes the `hook:git` bus namespace for downstream consumers such as
 * `GitWatcher`.
 * @packageDocumentation
 */

import type { IMakaioBus } from '@makaio/bus-core';
import type { MakaioNodeExtension } from '@makaio/contracts';
import { GitHookNamespace } from '@makaio/contracts';
import { createInboundHookNamespace } from '@makaio/inbound-hooks';
import { gitHooksCli } from './cli/index.js';
import { GitHookTranslatorService } from './service/git-hook-translator-service.js';

/**
 * Git hooks extension package manifest.
 *
 * Owns the `hook:git` raw inbound hook namespace and the `gitHook` capability
 * namespace for coverage queries. Exposes the `git-hooks` CLI command for
 * repository-scoped hook management.
 */
export const gitHooksPackage: MakaioNodeExtension<IMakaioBus> = {
  name: 'git-hooks',
  displayName: 'Git Hooks',
  version: '0.1.0',
  surface: 'headless',
  namespaces: [createInboundHookNamespace('git'), GitHookNamespace],
  cli: gitHooksCli,
  create: (ctx) => new GitHookTranslatorService(ctx.bus),
};
