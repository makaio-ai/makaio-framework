/**
 * Synthetic workspace scaffolding for the agent-client probe harness.
 *
 * Creates a fresh temporary directory per provider run containing:
 * - A minimal synthetic project directory the CLI can operate in.
 * - The scenario manifest as a JSON file for traceability.
 * - An empty config directory pointed to by the isolation env var.
 *
 * The workspace is disposable and never reads or mutates the user's
 * real provider configuration.
 * @packageDocumentation
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProviderId, ScenarioManifest } from './types.js';

/**
 * Layout of the temporary workspace created for a probe run.
 */
export interface ProbeWorkspace {
  /** Root of the temporary directory tree. */
  readonly rootDir: string;
  /** Directory used as the synthetic project workspace for the CLI. */
  readonly projectDir: string;
  /** Directory pointed to by the config isolation env var. */
  readonly configDir: string;
  /** Path to the written manifest file. */
  readonly manifestPath: string;
}

/**
 * Creates a fresh temporary workspace for a probe run.
 * @param params - Workspace creation parameters.
 * @param params.provider - The provider this workspace is for.
 * @param params.manifest - The scenario manifest to write into the workspace.
 * @returns The workspace layout.
 */
export async function createProbeWorkspace(params: {
  provider: ProviderId;
  manifest: ScenarioManifest;
}): Promise<ProbeWorkspace> {
  const { provider, manifest } = params;
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), `makaio-agent-probe-${provider}-`));
  const projectDir = path.join(rootDir, 'project');
  const configDir = path.join(rootDir, 'config');
  const manifestPath = path.join(rootDir, 'manifest.json');

  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(configDir, { recursive: true });

  // Create a minimal synthetic workspace
  await fs.writeFile(
    path.join(projectDir, 'MAKAIO_PROBE.md'),
    [
      '# Makaio Agent Client Probe',
      '',
      'This is a synthetic workspace created by the agent-client probe harness.',
      'It contains only stable markers for hook event testing.',
      '',
      `Provider: ${provider}`,
      `Pinned version: ${manifest.pinnedVersion}`,
    ].join('\n'),
    'utf8',
  );

  // Write the manifest for traceability
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  return { rootDir, projectDir, configDir, manifestPath };
}

/**
 * Cleans up a probe workspace by removing its root directory.
 * @param workspace - The workspace to clean up.
 */
export async function cleanupProbeWorkspace(workspace: ProbeWorkspace): Promise<void> {
  await fs.rm(workspace.rootDir, { recursive: true, force: true });
}
