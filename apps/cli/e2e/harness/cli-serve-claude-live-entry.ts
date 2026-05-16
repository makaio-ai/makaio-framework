/**
 * CLI serve entry for live Claude Agent SDK examples.
 *
 * Uses the real `makaio serve` command path with preloaded framework packages
 * required by the `claude-code` adapter, avoiding filesystem package discovery
 * in the E2E harness.
 */
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { IMakaioBus } from '@makaio/bus-core';
import { ExplicitDescriptorDiscovery } from '@makaio/runtime-node';
import type { DiscoveredExtension } from '@makaio/runtime-node';
import type { MakaioNodeExtension } from '@makaio/contracts';
import { CLIDetectionSubjects } from '@makaio/services-core/cli-detection/namespace';
import { anthropicPackage } from '../../../../providers/anthropic/src/package.js';
import { kimiPackage } from '../../../../providers/kimi/src/package.js';
import { opencodeGoPackage } from '../../../../providers/opencode-go/src/package.js';
import { zAiPackage } from '../../../../providers/z-ai/src/package.js';
import { claudeCodePackage } from '../../../../clients/claude-code/src/package.js';
import { claudeAgentSdkPackage } from '../../../../adapters/implementations/claude-agent-sdk/src/package.js';
import { main } from '../../src/main.js';

const execFileAsync = promisify(execFile);
const SEMVER_PATTERN = /\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/;
const CLI_DETECTION_PROBE_TIMEOUT_MS = 5_000;

type RuntimeNodeExtension = MakaioNodeExtension<IMakaioBus>;

const cliDetectionHarnessPackage: RuntimeNodeExtension = {
  name: 'cli-detection-harness',
  displayName: 'CLI Detection Harness',
  version: '0.1.0',
  create: (ctx) => {
    let cleanup: (() => void) | undefined;
    return {
      init: async () => {
        cleanup = ctx.bus.on(CLIDetectionSubjects.scan, async (request) => {
          const results = await Promise.all(
            request.payload.binaries.map(async (binary) => {
              try {
                const { stdout } = await execFileAsync('which', [binary], {
                  encoding: 'utf8',
                  timeout: CLI_DETECTION_PROBE_TIMEOUT_MS,
                });
                const binaryPath = stdout.trim();
                const version = await execFileAsync(binaryPath, ['--version'], {
                  encoding: 'utf8',
                  timeout: CLI_DETECTION_PROBE_TIMEOUT_MS,
                })
                  .then((result) => SEMVER_PATTERN.exec((result.stdout || result.stderr).trim())?.[0])
                  .catch(() => undefined);
                return { binary, found: true, path: binaryPath, ...(version ? { version } : {}) };
              } catch {
                return { binary, found: false };
              }
            }),
          );
          request.setResult({ results });
        });
      },
      destroy: async () => cleanup?.(),
    };
  },
};

/**
 * Build a preloaded discovery entry for an in-repo framework package.
 * @param extension - Package descriptor exported by the server entrypoint.
 * @param packageRootUrl - Package root URL relative to this harness file.
 * @returns Discovery entry consumed by `ExplicitDescriptorDiscovery`.
 */
function preloaded(extension: RuntimeNodeExtension, packageRootUrl: string): DiscoveredExtension {
  return {
    descriptor: {
      name: extension.name,
      displayName: extension.displayName,
      version: extension.version,
      makaio: { framework: '>=0.1.0' },
      entrypoints: { server: true },
    },
    extensionPath: fileURLToPath(new URL(packageRootUrl, import.meta.url)),
    source: 'local',
    preloadedModule: { default: extension },
  };
}

await main(['node', 'cli-serve-claude-live-entry.ts', 'serve', '--port', '0'], [], undefined, {
  boot: {
    discovery: new ExplicitDescriptorDiscovery([
      preloaded(cliDetectionHarnessPackage, './'),
      preloaded(anthropicPackage, '../../../../providers/anthropic/'),
      preloaded(zAiPackage, '../../../../providers/z-ai/'),
      preloaded(kimiPackage, '../../../../providers/kimi/'),
      preloaded(opencodeGoPackage, '../../../../providers/opencode-go/'),
      preloaded(claudeCodePackage, '../../../../clients/claude-code/'),
      preloaded(claudeAgentSdkPackage, '../../../../adapters/implementations/claude-agent-sdk/'),
    ]),
  },
});
