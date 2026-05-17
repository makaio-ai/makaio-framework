#!/usr/bin/env tsx
/**
 * Standalone CLI entry point for direct Node/tsx invocation.
 *
 * The packaged Electron launcher has its own host entry in
 * `apps/electron/src/cli-entry.ts`; this file owns the reusable
 * headless CLI app surface used by development scripts and config-selected
 * standalone CLI execution.
 */
import { buildNodeRuntimeOptions, resolveMakaioHome } from '@makaio/runtime-node';
import { main } from './main.js';

const makaioHome = resolveMakaioHome(process.env);
const nodeRuntimeOptions = await buildNodeRuntimeOptions({ makaioHome, env: process.env });

void main(process.argv, [], nodeRuntimeOptions.discovery, {
  boot: nodeRuntimeOptions,
});
