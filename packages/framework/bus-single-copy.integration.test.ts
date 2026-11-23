import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { prepareInstalledPackageConsumer } from './installed-package-consumer.fixture.js';

const execFileAsync = promisify(execFile);
const INSTALL_TIMEOUT_MS = 120_000;
const ASSERTION_TIMEOUT_MS = 60_000;
const SETUP_OPERATIONS_TIMEOUT_MS = INSTALL_TIMEOUT_MS + ASSERTION_TIMEOUT_MS;
const SETUP_TIMEOUT_MS = SETUP_OPERATIONS_TIMEOUT_MS + 5_000;

/** Marker text that exists once in the source of the minting module. */
const MINT_MARKER = 'Invalid call context';

/**
 * Runtime consumer: mints through the kernel entry and reads through the public entry.
 * Both entries must share one minting module, otherwise the stamp registry is split.
 */
const MINT_CONSUMER = String.raw`
import { writeFile } from 'node:fs/promises';
import { isMintedCallContext } from '@makaio/framework/bus';
import { mintCallContext } from '@makaio/framework/bus/kernel-api';

const party = { kind: 'makaio.host', id: 'consumer' };
const minted = mintCallContext({ caller: party, principal: party });
await writeFile(
  'result.json',
  JSON.stringify({ minted: isMintedCallContext(minted), spreadCopy: isMintedCallContext({ ...minted }) }),
);
`;

let temporaryRoot: string | undefined;
let packageRoot: string;
let runtimeResult: unknown;

/**
 * List every `.mjs` file below a directory.
 * @param directory - Directory to walk.
 * @returns Absolute file paths.
 */
async function listModules(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return listModules(path);
      return entry.name.endsWith('.mjs') ? [path] : [];
    }),
  );
  return nested.flat();
}

/**
 * Install the shared tarball and run the runtime consumer.
 * @param root - Temporary directory owned by this suite.
 * @param signal - Deadline shared by setup's bounded child processes.
 */
async function prepareConsumer(root: string, signal: AbortSignal): Promise<void> {
  const installed = await prepareInstalledPackageConsumer({
    root,
    consumerName: 'bus-single-copy-consumer',
    tarball: inject('installedFrameworkTarball'),
    signal,
    installTimeoutMs: INSTALL_TIMEOUT_MS,
  });
  packageRoot = join(installed.consumerRoot, 'node_modules', '@makaio', 'framework');
  await writeFile(join(installed.consumerRoot, 'consumer.mjs'), MINT_CONSUMER);
  await execFileAsync(process.execPath, ['consumer.mjs'], {
    cwd: installed.consumerRoot,
    timeout: ASSERTION_TIMEOUT_MS,
    signal,
  });
  runtimeResult = JSON.parse(await readFile(join(installed.consumerRoot, 'result.json'), 'utf8'));
}

describe('installed bus entries share one minting module', () => {
  beforeAll(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'bus-single-copy-'));
    await prepareConsumer(temporaryRoot, AbortSignal.timeout(SETUP_OPERATIONS_TIMEOUT_MS));
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('recognises a context minted through the kernel entry and rejects a spread copy', () => {
    expect(runtimeResult).toEqual({ minted: true, spreadCopy: false });
  });

  it('keeps the minting module in exactly one file of dist/ that both bus entries import', async () => {
    const dist = join(packageRoot, 'dist');
    const modules = await listModules(dist);
    const sources = await Promise.all(modules.map(async (file) => ({ file, text: await readFile(file, 'utf8') })));
    const holders = sources.filter(({ text }) => text.includes(MINT_MARKER));
    expect(holders.map(({ file }) => relative(dist, file))).toHaveLength(1);
    const holder = holders[0];
    if (!holder) throw new Error('No file contains the minting module');
    const holderName = relative(join(dist, 'bus'), holder.file).replaceAll('\\', '/');
    const holderImport = holderName.startsWith('.') ? holderName : `./${holderName}`;

    for (const entry of ['index.mjs', 'kernel-api.mjs']) {
      const text = await readFile(join(dist, 'bus', entry), 'utf8');
      expect(
        text.includes(`"${holderImport}"`) || text.includes(`'${holderImport}'`),
        `dist/bus/${entry} imports the minting module`,
      ).toBe(true);
    }
  });
});
