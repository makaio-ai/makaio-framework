#!/usr/bin/env tsx
/**
 * Release-only smoke test: verifies that upstream managed binary artifacts
 * are reachable and correctly structured for the pinned versions declared
 * in first-party client packages.
 *
 * NOT part of `yarn validate` — requires network access and real upstream artifacts.
 * @example
 * ```bash
 * tsx framework/scripts/smoke-managed-binaries.ts
 * ```
 * @packageDocumentation
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { clientDefinition as codexClientDefinition } from '../clients/codex/src/definition.js';

const exec = promisify(execFile);
const NPM_INSTALL_TIMEOUT_MS = 120_000;
const VERSION_COMMAND_TIMEOUT_MS = 10_000;
const FETCH_TIMEOUT_MS = 30_000;

/**
 * Installs `@openai/codex` into a temporary directory via npm, then verifies
 * that the `codex` binary is present and reports the expected version.
 * @returns Promise that resolves when verification succeeds.
 */
async function assertCodexNpmLayout(): Promise<void> {
  console.log('[smoke] Verifying Codex npm install layout...');
  const { managedInstall, versionCommand } = codexClientDefinition;
  if (managedInstall?.type !== 'npm') {
    throw new Error('Codex smoke requires an npm managed-install descriptor');
  }
  if (!versionCommand) {
    throw new Error('Codex smoke requires a version command');
  }

  const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-codex-smoke-'));
  try {
    const expectedVersion = managedInstall.version;
    await exec(
      'npm',
      [
        'install',
        `${managedInstall.package}@${expectedVersion}`,
        '--prefix',
        targetDir,
        '--no-save',
        '--ignore-scripts',
      ],
      { timeout: NPM_INSTALL_TIMEOUT_MS },
    );
    const executablePath =
      typeof versionCommand.executable === 'string'
        ? versionCommand.executable
        : ((process.platform === 'win32'
            ? versionCommand.executable.win32
            : process.platform === 'darwin'
              ? versionCommand.executable.darwin
              : process.platform === 'linux'
                ? versionCommand.executable.linux
                : undefined) ?? versionCommand.executable.default);
    const executable = path.join(targetDir, executablePath);
    await fs.access(executable);
    const { stdout } = await exec(executable, [...versionCommand.args], { timeout: VERSION_COMMAND_TIMEOUT_MS });
    if (!stdout.includes(expectedVersion)) {
      throw new Error(`Codex smoke expected version ${expectedVersion}, got: ${stdout.trim()}`);
    }
    console.log('[smoke] ✓ Codex npm install layout verified');
  } finally {
    await fs.rm(targetDir, { recursive: true, force: true });
  }
}

/** The shape of a single platform entry in a Claude Code release manifest. */
interface ClaudeManifestPlatformEntry {
  readonly binary?: string;
  readonly checksum?: string;
}

/** The shape of a Claude Code release manifest. */
interface ClaudeReleaseManifest {
  readonly platforms?: Record<string, ClaudeManifestPlatformEntry>;
}

/**
 * Fetches the Claude Code release manifest for the pinned version and verifies
 * that all required platform entries contain a `binary` and `checksum` field.
 * Also verifies that the detached signature file is reachable.
 * @returns Promise that resolves when verification succeeds.
 */
async function assertClaudeReleaseManifest(): Promise<void> {
  console.log('[smoke] Verifying Claude Code release manifest...');
  const base = 'https://downloads.claude.ai/claude-code-releases';
  const manifestResponse = await fetchWithTimeout(`${base}/2.1.143/manifest.json`);
  if (!manifestResponse.ok) {
    throw new Error(`Claude manifest fetch failed: ${manifestResponse.status} ${manifestResponse.statusText}`);
  }
  const manifest = (await manifestResponse.json()) as ClaudeReleaseManifest;
  const required = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64'];
  for (const platform of required) {
    const entry = manifest.platforms?.[platform];
    if (!entry?.binary?.trim() || !entry.checksum?.trim()) {
      throw new Error(`Claude manifest missing binary/checksum for ${platform}`);
    }
  }
  const signatureResponse = await fetchWithTimeout(`${base}/2.1.143/manifest.json.sig`);
  if (!signatureResponse.ok) {
    throw new Error(`Claude manifest signature fetch failed: ${signatureResponse.status}`);
  }
  console.log('[smoke] ✓ Claude Code release manifest verified');
}

/**
 * Fetch a release artifact with a bounded timeout.
 * @param url - Artifact URL to fetch.
 * @returns Fetch response for the requested URL.
 */
function fetchWithTimeout(url: string): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

/**
 * Entry point: runs all managed binary smoke checks sequentially.
 * @returns Promise that resolves when all smoke checks pass.
 */
async function main(): Promise<void> {
  console.log('[smoke] Starting managed binary smoke tests...\n');
  await assertCodexNpmLayout();
  await assertClaudeReleaseManifest();
  console.log('\n[smoke] All managed binary smoke tests passed.');
}

await main();
