import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_ROOT = path.resolve(__dirname, '../../..');
const CLI_ENTRY = path.resolve(FRAMEWORK_ROOT, 'apps/cli/src/cli-entry.ts');
const CONTRACTS_ROOT = path.resolve(FRAMEWORK_ROOT, 'core/contracts');
const WORKFLOW_EXTENSION_ROOT = path.resolve(FRAMEWORK_ROOT, 'extensions/workflow');
const STANDALONE_RUN_TIMEOUT_MS = 60_000;

/**
 * Build a runtime config that discovers the checked-out workflow extension only.
 * @param workflowExtensionRoot - Absolute path to the workflow extension descriptor root.
 * @returns ESM config module source.
 */
function makeConfigSource(workflowExtensionRoot: string): string {
  return `
export default {
  extensions: {
    autoDiscover: true,
    discoveryPaths: [${JSON.stringify(workflowExtensionRoot)}],
  },
};
`;
}

/**
 * Build a workflow module that exercises path-based standalone execution
 * through the public workflow authoring helper.
 * @param markerPath - Absolute path written by the runtime function step.
 * @returns ESM workflow module source.
 */
function makeWorkflowSource(markerPath: string): string {
  return `
import { writeFile } from 'node:fs/promises';
import { defineWorkflow } from '@makaio/contracts';

const workflow = defineWorkflow('standalone-cli-smoke', {
  name: 'Standalone CLI Smoke',
});

workflow.station('write-marker', async () => {
    await writeFile(${JSON.stringify(markerPath)}, JSON.stringify({ ok: true }), 'utf8');
    return { ok: true };
  });

export default workflow;
`;
}

describe('standalone workflow run', { timeout: STANDALONE_RUN_TIMEOUT_MS }, () => {
  it('runs a relative workflow file through the embedded runtime when no server is reachable', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'makaio-cli-workflow-run-'));
    try {
      const configPath = path.join(tempRoot, 'makaio.config.mjs');
      const workflowPath = path.join(tempRoot, 'workflow.mjs');
      const markerPath = path.join(tempRoot, 'marker.json');
      const homePath = path.join(tempRoot, '.makaio');
      const dbPath = path.join(tempRoot, 'makaio.db');
      const contractsLinkPath = path.join(tempRoot, 'node_modules', '@makaio', 'contracts');

      await mkdir(path.dirname(contractsLinkPath), { recursive: true });
      await symlink(CONTRACTS_ROOT, contractsLinkPath, process.platform === 'win32' ? 'junction' : 'dir');
      await writeFile(configPath, makeConfigSource(WORKFLOW_EXTENSION_ROOT), 'utf8');
      await writeFile(workflowPath, makeWorkflowSource(markerPath), 'utf8');

      const { stdout } = await execFileAsync(
        'tsx',
        [CLI_ENTRY, 'workflow', 'run', './workflow.mjs', '--payload', '{"source":"e2e"}'],
        {
          cwd: tempRoot,
          env: {
            ...process.env,
            MAKAIO_BUS_URL: 'ws://127.0.0.1:1/bus',
            MAKAIO_CONFIG_FILE: configPath,
            MAKAIO_DATABASE_PATH: dbPath,
            MAKAIO_HOME: homePath,
          },
          encoding: 'utf8',
          timeout: STANDALONE_RUN_TIMEOUT_MS,
        },
      );

      expect(stdout).toContain('Running workflow: ./workflow.mjs (executionId:');
      expect(stdout).toMatch(/Workflow completed in \d+ms \(executionId: .+\)/u);
      await expect(readFile(markerPath, 'utf8')).resolves.toBe('{"ok":true}');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
