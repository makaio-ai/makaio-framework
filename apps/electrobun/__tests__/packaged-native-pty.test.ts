/**
 * Native PTY bridge package-closure integration test.
 *
 * Recreates the relevant `Resources/app` paths from the Electrobun copy map,
 * then runs the copied Node executable against the copied framework bridge.
 * This catches missing native addon dependencies that a config-only assertion
 * cannot detect.
 */
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, describe, expect, it } from 'vitest';
import config from '../electrobun.config.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const PTY_BRIDGE_SOURCE = path.join(
  PACKAGE_ROOT,
  '..',
  '..',
  'subsystems',
  'native-session-supervisor',
  'src',
  'pty',
  'bridge',
  'pty-bridge.cjs',
);
const TEST_ROOT = mkdtempSync(path.join(tmpdir(), 'makaio-electrobun-pty-'));

afterAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

/**
 * Resolve a package-copy source by its configured destination.
 * @param destination - Destination inside the generated Electrobun bundle.
 * @returns Absolute source path.
 */
function resolveCopySource(destination: string): string {
  const entry = Object.entries(config.build?.copy ?? {}).find(
    ([, configuredDestination]) => configuredDestination === destination,
  );
  if (!entry) throw new Error(`Missing Electrobun package copy entry for ${destination}`);
  return path.resolve(PACKAGE_ROOT, entry[0]);
}

/**
 * Run the packaged bridge until its PTY has emitted output and exited.
 * @param executable - Copied Node executable.
 * @param bridge - Copied framework PTY bridge.
 * @returns Parsed bridge messages.
 */
async function runBridge(executable: string, bridge: string): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [bridge], { stdio: ['pipe', 'pipe', 'pipe'] });
    const messages: Array<Record<string, unknown>> = [];
    let pending = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Timed out waiting for packaged native PTY bridge output'));
    }, 10_000);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (line) messages.push(JSON.parse(line) as Record<string, unknown>);
      }
      if (messages.some((message) => message['event'] === 'exit')) child.stdin.end();
    });
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(messages);
      else reject(new Error(`Packaged native PTY bridge exited with ${code}`));
    });
    child.stdin.write(
      `${JSON.stringify({
        id: 1,
        cmd: 'spawn',
        file: process.execPath,
        args: ['-e', "process.stdout.write('packaged-pty-ok')"],
        options: { cols: 80, rows: 24 },
      })}\n`,
    );
  });
}

describe('packaged native PTY bridge', () => {
  it('spawns and exits through the copied host Node and node-pty closure', async () => {
    const appRoot = path.join(TEST_ROOT, 'Resources', 'app');
    const frameworkDestination = path.join(appRoot, 'node_modules', '@makaio', 'framework', 'dist');
    const bridgeDestination = path.join(frameworkDestination, 'runtime-node', 'bridge', 'pty-bridge.cjs');
    const nodeDestination = path.join(appRoot, 'node', process.platform === 'win32' ? 'node.exe' : 'node');
    const nodeCopyDestination = `node/${process.platform === 'win32' ? 'node.exe' : 'node'}`;

    mkdirSync(path.dirname(bridgeDestination), { recursive: true });
    mkdirSync(path.dirname(nodeDestination), { recursive: true });
    cpSync(PTY_BRIDGE_SOURCE, bridgeDestination);
    cpSync(resolveCopySource(nodeCopyDestination), nodeDestination);
    cpSync(resolveCopySource('node_modules/node-pty'), path.join(appRoot, 'node_modules', 'node-pty'), {
      recursive: true,
    });
    cpSync(resolveCopySource('node_modules/node-addon-api'), path.join(appRoot, 'node_modules', 'node-addon-api'), {
      recursive: true,
    });

    const messages = await runBridge(nodeDestination, bridgeDestination);
    expect(messages).toContainEqual(expect.objectContaining({ event: 'spawned' }));
    expect(messages).toContainEqual(expect.objectContaining({ event: 'exit', exitCode: 0 }));
    expect(messages).toContainEqual(
      expect.objectContaining({ event: 'data', data: Buffer.from('packaged-pty-ok', 'utf8').toString('base64') }),
    );
  });
});
