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
import type { ClientDefinition, NpmInstallDescriptor, SignedBinaryBucketInstallDescriptor } from '@makaio/contracts';
// `clients/*` are framework packages shipped from this repository root, not
// product code, so importing their definitions crosses no distribution
// boundary. What the checks below must not do is encode a *specific* client:
// they read only `managedInstall`, so the set of clients is data.
import { clientDefinition as claudeCodeClientDefinition } from '../clients/claude-code/src/definition.js';
import { clientDefinition as codexClientDefinition } from '../clients/codex/src/definition.js';

/**
 * Clients whose managed installs this smoke run verifies.
 *
 * An explicit list rather than a filesystem scan: only clients that actually
 * ship a managed binary belong here, and a release check should fail loudly
 * when an expected client is missing rather than silently verifying fewer
 * artifacts than the release contains. Each entry is verified through its own
 * `managedInstall` descriptor, so adding a client is one line here and bumping
 * a pin needs no edit at all.
 */
const MANAGED_INSTALL_CLIENTS: readonly ClientDefinition[] = [claudeCodeClientDefinition, codexClientDefinition];

const exec = promisify(execFile);
const NPM_INSTALL_TIMEOUT_MS = 120_000;
const VERSION_COMMAND_TIMEOUT_MS = 10_000;
const FETCH_TIMEOUT_MS = 30_000;

/**
 * Installs a client's pinned npm package into a temporary directory, then
 * verifies that its executable is present and reports the expected version.
 * @param definition - Client whose npm managed install is verified.
 * @param managedInstall - The client's npm managed-install descriptor.
 * @returns Promise that resolves when verification succeeds.
 */
async function assertNpmInstallLayout(
  definition: ClientDefinition,
  managedInstall: NpmInstallDescriptor,
): Promise<void> {
  console.log(`[smoke] Verifying ${definition.name} npm install layout...`);
  const { versionCommand } = definition;
  if (!versionCommand) {
    throw new Error(`${definition.name} smoke requires a version command`);
  }

  const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), `makaio-${definition.id}-smoke-`));
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
      throw new Error(`${definition.name} smoke expected version ${expectedVersion}, got: ${stdout.trim()}`);
    }
    console.log(`[smoke] ✓ ${definition.name} npm install layout verified (${expectedVersion})`);
  } finally {
    await fs.rm(targetDir, { recursive: true, force: true });
  }
}

/** The shape of a single platform entry in a signed-binary-bucket release manifest. */
interface ManifestPlatformEntry {
  readonly binary?: string;
  readonly checksum?: string;
}

/** The shape of a signed-binary-bucket release manifest. */
interface SignedBucketReleaseManifest {
  readonly platforms?: Record<string, ManifestPlatformEntry>;
}

/**
 * Fetches a client's release manifest for the pinned version and verifies that
 * every platform the descriptor promises contains a `binary` and `checksum`
 * field. Also verifies that the detached signature file is reachable.
 *
 * Version, bucket location, and platform coverage are all read from the client
 * descriptor, so bumping the pin needs no edit here and the smoke run cannot
 * silently verify a version other than the one we ship. The manifest layout is
 * a property of the `signed-binary-bucket` strategy, not of any one client, so
 * every client using that strategy is checked the same way.
 * @param definition - Client whose signed-bucket release is verified.
 * @param managedInstall - The client's signed-binary-bucket managed-install descriptor.
 * @returns Promise that resolves when verification succeeds.
 */
async function assertSignedBucketRelease(
  definition: ClientDefinition,
  managedInstall: SignedBinaryBucketInstallDescriptor,
): Promise<void> {
  console.log(`[smoke] Verifying ${definition.name} release manifest...`);
  const { baseUrl, manifestPathTemplate, manifestSignaturePathTemplate, platforms } = managedInstall.config;
  const version = managedInstall.version;
  const resolve = (template: string): string => `${baseUrl}/${template.replace('{version}', version)}`;

  const manifestResponse = await fetchWithTimeout(resolve(manifestPathTemplate));
  if (!manifestResponse.ok) {
    throw new Error(
      `${definition.name} manifest fetch failed: ${manifestResponse.status} ${manifestResponse.statusText}`,
    );
  }
  const manifest = (await manifestResponse.json()) as SignedBucketReleaseManifest;
  for (const platform of Object.values(platforms)) {
    const entry = manifest.platforms?.[platform];
    if (!entry?.binary?.trim() || !entry.checksum?.trim()) {
      throw new Error(`${definition.name} manifest missing binary/checksum for ${platform}`);
    }
  }
  // Reachability only, deliberately. Authenticity is the install strategy's job:
  // it imports the declared public key, rejects a fingerprint that does not match
  // `publicKeyFingerprint`, and runs `gpg --verify` over this signature before any
  // binary is used. Repeating that here would need gpg on every machine running
  // the smoke check while proving nothing the install path does not already prove.
  // What this check does prove is that the pinned version still publishes both
  // artifacts at the declared template paths — the drift a signature check cannot
  // catch, because a missing manifest never reaches verification at all.
  const signatureResponse = await fetchWithTimeout(resolve(manifestSignaturePathTemplate));
  if (!signatureResponse.ok) {
    throw new Error(`${definition.name} manifest signature fetch failed: ${signatureResponse.status}`);
  }
  console.log(`[smoke] ✓ ${definition.name} release manifest verified (${version})`);
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
  for (const definition of MANAGED_INSTALL_CLIENTS) {
    const managedInstall = definition.managedInstall;
    if (!managedInstall) {
      throw new Error(`${definition.name} is listed for managed-binary smoke but declares no managedInstall`);
    }
    switch (managedInstall.type) {
      case 'npm':
        await assertNpmInstallLayout(definition, managedInstall);
        break;
      case 'signed-binary-bucket':
        await assertSignedBucketRelease(definition, managedInstall);
        break;
      default: {
        // Exhaustive over ManagedInstallDescriptor: adding a strategy without a
        // check here fails to compile, so a new one cannot silently pass this
        // smoke run by matching no branch.
        const unhandled: never = managedInstall;
        throw new Error(`${definition.name} declares unhandled managed-install strategy: ${JSON.stringify(unhandled)}`);
      }
    }
  }
  console.log('\n[smoke] All managed binary smoke tests passed.');
}

await main();
