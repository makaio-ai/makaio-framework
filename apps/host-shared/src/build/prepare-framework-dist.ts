#!/usr/bin/env tsx
/**
 * Build and assemble the framework umbrella dist before desktop packaging.
 *
 * Desktop app package scripts run from `apps/electron` or `apps/electrobun`;
 * the resolved workspace root must expose the stable framework-dist script
 * pair used by supported source layouts.
 */
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolveWorkspaceRoot } from '@makaio/utils/workspace-root';

const YARN_SCRIPT_TIMEOUT_MS = 10 * 60 * 1000;

interface FrameworkDistBuildPlan {
  readonly cwd: string;
  readonly scripts: readonly string[];
}

/**
 * Resolve the script sequence needed for framework dist assembly.
 * @param packageRoot - Desktop host package root.
 * @returns Build plan for framework dist assembly.
 */
export function resolveFrameworkDistBuildPlan(packageRoot: string): FrameworkDistBuildPlan {
  const workspaceRoot = resolveWorkspaceRoot(packageRoot);
  return { cwd: workspaceRoot, scripts: ['build:framework', 'build:framework:assemble'] };
}

/**
 * Run a package-manager script and fail with its exit code on error.
 * @param cwd - Directory where Yarn should run.
 * @param script - Script name to execute.
 */
function runYarnScript(cwd: string, script: string): void {
  const result = spawnSync('yarn', [script], { cwd, stdio: 'inherit', timeout: YARN_SCRIPT_TIMEOUT_MS });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const plan = resolveFrameworkDistBuildPlan(process.cwd());
  for (const script of plan.scripts) {
    runYarnScript(plan.cwd, script);
  }
}
