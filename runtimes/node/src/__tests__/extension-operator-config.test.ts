import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  encodeExtensionOperatorConfigName,
  type ExtensionOperatorConfigEntry,
  type JsonValue,
} from '@makaio/contracts';
import {
  MAX_OPERATOR_CONFIG_BYTES,
  createExtensionOperatorConfigSnapshot,
  loadExtensionOperatorConfig,
  resolveExtensionOperatorConfigDir,
  warnOnUnappliedExtensionOperatorConfig,
} from '../extension-operator-config.js';

/** A permission-denied directory is unreachable on Windows and irrelevant to root. */
const CAN_DENY_DIRECTORY_ACCESS = process.platform !== 'win32' && process.getuid?.() !== 0;

/** File names that survive the `.json` check but decode to no extension name. */
const UNDECODABLE_FILE_NAMES = ['%40acme%2fweather.json', 'gateway!.json', '%zz.json'];

/** Secret-looking value written into fixtures to prove diagnostics never echo file content. */
const SENTINEL_VALUE = 'never-echo-this-token';

/**
 * Encode a name the test states is addressable, failing loudly when it is not.
 * @param name - Extension name the test expects to have a file stem.
 * @returns That name's file stem, never the string `undefined`.
 */
function stemOf(name: string): string {
  const stem = encodeExtensionOperatorConfigName(name);
  if (stem === undefined) throw new Error(`expected "${name}" to be addressable`);
  return stem;
}

describe('extension operator config loader', () => {
  let makaioHome: string;
  let configDir: string;
  let warnSpy: MockInstance<typeof console.warn>;

  beforeEach(async () => {
    makaioHome = await fs.mkdtemp(path.join(tmpdir(), 'makaio-operator-config-'));
    configDir = resolveExtensionOperatorConfigDir(makaioHome);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    warnSpy.mockRestore();
    await fs.rm(makaioHome, { recursive: true, force: true });
  });

  /**
   * Write one operator config file, creating the config directory on demand.
   * @param fileName - File name inside the operator config directory.
   * @param content - Raw file content, written verbatim so malformed input stays malformed.
   * @returns Absolute path to the written file.
   */
  async function writeConfigFile(fileName: string, content: string): Promise<string> {
    await fs.mkdir(configDir, { recursive: true });
    const filePath = path.join(configDir, fileName);
    await fs.writeFile(filePath, content, 'utf-8');
    return filePath;
  }

  /**
   * Collect every warning the loader emitted as one searchable list.
   * @returns One joined string per `console.warn` call.
   */
  function warnings(): string[] {
    return warnSpy.mock.calls.map((call) => call.map((part) => String(part)).join(' '));
  }

  it('resolves the operator config directory beneath the Makaio home', () => {
    expect(resolveExtensionOperatorConfigDir('/data/.makaio')).toBe(path.join('/data/.makaio', 'config', 'extensions'));
  });

  it('yields an empty snapshot without warning or creating anything when the directory is absent', async () => {
    const snapshot = await loadExtensionOperatorConfig({ makaioHome });

    expect(snapshot.entries.length).toBe(0);
    expect(snapshot.get('gateway')).toBeUndefined();
    expect(warnings()).toEqual([]);
    await expect(fs.access(configDir)).rejects.toThrow();
  });

  it('fails boot when a file sits where the operator config directory belongs', async () => {
    await fs.mkdir(path.dirname(configDir), { recursive: true });
    await fs.writeFile(configDir, 'not a directory', 'utf-8');

    // Continuing would start every extension without its operator config and
    // look exactly like a home that has none.
    await expect(loadExtensionOperatorConfig({ makaioHome })).rejects.toThrow(
      `[boot] Cannot read operator config directory at ${configDir}: ENOTDIR`,
    );
  });

  it('fails boot when the operator config directory cannot be listed', async (ctx) => {
    if (!CAN_DENY_DIRECTORY_ACCESS) {
      ctx.skip('Requires a filesystem where an unprivileged process can be denied directory access');
      return;
    }
    await writeConfigFile('gateway.json', JSON.stringify({ port: 6299 }));
    await fs.chmod(configDir, 0o000);

    try {
      await expect(loadExtensionOperatorConfig({ makaioHome })).rejects.toThrow(
        `[boot] Cannot read operator config directory at ${configDir}: EACCES`,
      );
    } finally {
      await fs.chmod(configDir, 0o700);
    }
  });

  it('reads an unscoped extension name from a file stem spelled exactly like it', async () => {
    const filePath = await writeConfigFile('gateway.json', JSON.stringify({ port: 6299, upstreams: { a: 1 } }));

    const snapshot = await loadExtensionOperatorConfig({ makaioHome });

    expect(snapshot.get('gateway')).toEqual({
      kind: 'config',
      source: filePath,
      config: { port: 6299, upstreams: { a: 1 } },
    });
    expect(warnings()).toEqual([]);
  });

  it('round-trips a scoped extension name through a single path segment', async () => {
    const stem = stemOf('@acme/weather-tools');
    expect(stem).toBe('%40acme%2Fweather-tools');
    const filePath = await writeConfigFile(`${stem}.json`, JSON.stringify({ units: 'metric' }));

    const snapshot = await loadExtensionOperatorConfig({ makaioHome });

    expect(snapshot.get('@acme/weather-tools')).toEqual({
      kind: 'config',
      source: filePath,
      config: { units: 'metric' },
    });
    expect(await fs.readdir(configDir)).toEqual([`${stem}.json`]);
  });

  it('classifies a syntactically invalid file without reproducing its content', async () => {
    const filePath = await writeConfigFile('gateway.json', `{\n  "token": "${SENTINEL_VALUE}",\n}\n`);

    const snapshot = await loadExtensionOperatorConfig({ makaioHome });
    const entry = snapshot.get('gateway');

    expect(entry).toMatchObject({ kind: 'failure', reason: 'invalid-json', source: filePath });
    expect(entry).toHaveProperty('detail', expect.stringMatching(/^at position \d+/u));
    expect(JSON.stringify(entry)).not.toContain(SENTINEL_VALUE);
  });

  it('omits a detail when the parser reports no position', async () => {
    await writeConfigFile('gateway.json', '');

    const snapshot = await loadExtensionOperatorConfig({ makaioHome });

    expect(snapshot.get('gateway')).toEqual({
      kind: 'failure',
      reason: 'invalid-json',
      source: path.join(configDir, 'gateway.json'),
    });
  });

  it.each([
    ['an array', JSON.stringify([{ token: SENTINEL_VALUE }]), 'top-level value is an array'],
    ['null', 'null', 'top-level value is null'],
    ['a string', JSON.stringify(SENTINEL_VALUE), 'top-level value is a string'],
    ['a number', '42', 'top-level value is a number'],
  ])('rejects a file whose top-level JSON value is %s', async (_label, content, detail) => {
    await writeConfigFile('gateway.json', content);

    const snapshot = await loadExtensionOperatorConfig({ makaioHome });

    expect(snapshot.get('gateway')).toEqual({
      kind: 'failure',
      reason: 'not-an-object',
      source: path.join(configDir, 'gateway.json'),
      detail,
    });
  });

  it('classifies an entry it cannot read as unreadable', async () => {
    await fs.mkdir(path.join(configDir, 'gateway.json'), { recursive: true });

    const snapshot = await loadExtensionOperatorConfig({ makaioHome });

    expect(snapshot.get('gateway')).toEqual({
      kind: 'failure',
      reason: 'unreadable',
      source: path.join(configDir, 'gateway.json'),
      detail: 'EISDIR',
    });
  });

  it.each(UNDECODABLE_FILE_NAMES)('reports and skips %s, which encodes no extension name', async (fileName) => {
    await writeConfigFile(fileName, JSON.stringify({ port: 1 }));

    const snapshot = await loadExtensionOperatorConfig({ makaioHome });

    expect(snapshot.entries.length).toBe(0);
    expect(warnings()).toEqual([
      expect.stringContaining(`Ignoring ${path.join(configDir, fileName)}: its name is not the encoded form`),
    ]);
  });

  it('reports a non-JSON entry but stays silent about every dot-prefixed name', async () => {
    await writeConfigFile('gateway.yaml', 'port: 1');
    await writeConfigFile('.DS_Store', 'binary-ish');
    // An editor lock file: dot-prefixed and `.json`-suffixed at the same time,
    // which is why the dot is checked before the suffix.
    await writeConfigFile('.#gateway.json', JSON.stringify({ port: 1 }));
    await writeConfigFile('.hidden.json', JSON.stringify({ port: 1 }));
    await fs.mkdir(path.join(configDir, 'backups'), { recursive: true });

    const snapshot = await loadExtensionOperatorConfig({ makaioHome });

    expect(snapshot.entries.length).toBe(0);
    expect(warnings().sort()).toEqual([
      expect.stringContaining(`Ignoring ${path.join(configDir, 'backups')}`),
      expect.stringContaining(`Ignoring ${path.join(configDir, 'gateway.yaml')}`),
    ]);
  });

  it('rejects a file larger than the operator config size limit without reading it', async () => {
    const filePath = await writeConfigFile('gateway.json', 'x'.repeat(MAX_OPERATOR_CONFIG_BYTES + 1));

    const snapshot = await loadExtensionOperatorConfig({ makaioHome });

    expect(snapshot.get('gateway')).toEqual({
      kind: 'failure',
      reason: 'unreadable',
      source: filePath,
      detail: `exceeds ${MAX_OPERATOR_CONFIG_BYTES} bytes`,
    });
  });

  it('accepts a file exactly at the operator config size limit', async () => {
    const padding = ' '.repeat(MAX_OPERATOR_CONFIG_BYTES - '{"port":6299}'.length);
    await writeConfigFile('gateway.json', `{"port":6299}${padding}`);

    const snapshot = await loadExtensionOperatorConfig({ makaioHome });

    expect(snapshot.get('gateway')).toMatchObject({ kind: 'config', config: { port: 6299 } });
  });

  it('flattens control characters in an extension name before putting it in a warning', async () => {
    const extensionName = 'gate\u0007way\nrogue';
    await writeConfigFile(`${stemOf(extensionName)}.json`, JSON.stringify({ port: 1 }));
    const snapshot = await loadExtensionOperatorConfig({ makaioHome });
    warnSpy.mockClear();

    warnOnUnappliedExtensionOperatorConfig(snapshot, []);

    expect(warnings()).toEqual([expect.stringContaining('names extension "gate way rogue"')]);
    expect(warnings()[0]).not.toContain('\u0007');
  });

  it('stays silent about names that differ only in case but encode to distinct file names', async () => {
    // `ä-tools` and `Ä-tools` differ only in case, yet encode to `%C3%A4-tools`
    // and `%C3%84-tools`, which differ in more than case and therefore coexist
    // on every filesystem. Folding decoded names here would report a collision
    // that does not exist.
    await writeConfigFile(`${stemOf('ä-tools')}.json`, JSON.stringify({ port: 1 }));
    await writeConfigFile(`${stemOf('Ä-tools')}.json`, JSON.stringify({ port: 2 }));

    const snapshot = await loadExtensionOperatorConfig({ makaioHome });

    expect(snapshot.get('ä-tools')).toMatchObject({ kind: 'config', config: { port: 1 } });
    expect(snapshot.get('Ä-tools')).toMatchObject({ kind: 'config', config: { port: 2 } });
    expect(warnings()).toEqual([]);
  });

  it('keeps both files whose names differ only in case and reports that they are not portable', async (ctx) => {
    await writeConfigFile('Gateway.json', JSON.stringify({ port: 1 }));
    await writeConfigFile('gateway.json', JSON.stringify({ port: 2 }));
    if ((await fs.readdir(configDir)).length < 2) {
      // A case-insensitive filesystem stored one file, not two, so the pair this
      // warning is about cannot exist here. A name/file case mismatch on such a
      // filesystem is a different failure, reported as "not loaded" instead.
      ctx.skip('Requires a case-sensitive filesystem');
      return;
    }

    const snapshot = await loadExtensionOperatorConfig({ makaioHome });

    expect(snapshot.get('Gateway')).toMatchObject({ kind: 'config', config: { port: 1 } });
    expect(snapshot.get('gateway')).toMatchObject({ kind: 'config', config: { port: 2 } });
    const [collision] = warnings();
    expect(warnings()).toHaveLength(1);
    expect(collision).toContain('Gateway.json');
    expect(collision).toContain('gateway.json');
    expect(collision).toContain('differ only in case');
  });

  it('does not observe a file rewritten after the snapshot was taken', async () => {
    const filePath = await writeConfigFile('gateway.json', JSON.stringify({ port: 6299 }));
    const snapshot = await loadExtensionOperatorConfig({ makaioHome });

    await fs.writeFile(filePath, JSON.stringify({ port: 1 }), 'utf-8');
    expect(snapshot.get('gateway')).toMatchObject({ config: { port: 6299 } });

    await fs.rm(filePath);
    expect(snapshot.get('gateway')).toMatchObject({ config: { port: 6299 } });
  });
});

describe('createExtensionOperatorConfigSnapshot', () => {
  it('answers from the entries it captured rather than from the caller’s map', () => {
    const entry: ExtensionOperatorConfigEntry = { kind: 'config', source: 'test', config: { port: 1 } };
    const entries = new Map<string, ExtensionOperatorConfigEntry>([['gateway', entry]]);

    const snapshot = createExtensionOperatorConfigSnapshot(entries);
    entries.delete('gateway');

    expect(snapshot.get('gateway')).toBe(entry);
    expect(snapshot.entries).toEqual([['gateway', entry]]);
  });

  it('keeps its lookup store private, so a mutation attempt on the listing changes nothing', () => {
    const entry: ExtensionOperatorConfigEntry = { kind: 'config', source: 'test', config: { port: 1 } };
    const snapshot = createExtensionOperatorConfigSnapshot(
      new Map<string, ExtensionOperatorConfigEntry>([['gateway', entry]]),
    );
    const intruder: ExtensionOperatorConfigEntry = { kind: 'config', source: 'intruder', config: { port: 2 } };

    // The type refuses all three; an embedder writing JavaScript never sees the
    // type, so the value itself has to refuse them too — otherwise the layer
    // could change after boot has already resolved extensions against it.
    expect(Object.isFrozen(snapshot.entries)).toBe(true);
    expect(Reflect.set(snapshot.entries, 0, ['gateway', intruder])).toBe(false);
    expect(Reflect.set(snapshot.entries, 1, ['injected', intruder])).toBe(false);
    expect(Reflect.deleteProperty(snapshot.entries, 0)).toBe(false);

    expect(snapshot.get('gateway')).toBe(entry);
    expect(snapshot.get('injected')).toBeUndefined();
    expect(snapshot.entries).toEqual([['gateway', entry]]);
  });

  it('freezes the entry and its configuration tree so no holder can change it', () => {
    const config = { port: 1, upstreams: { primary: { url: 'https://a' } }, tags: ['a'] };
    const snapshot = createExtensionOperatorConfigSnapshot(
      new Map<string, ExtensionOperatorConfigEntry>([['gateway', { kind: 'config', source: 'test', config }]]),
    );

    // The caller keeps a reference to the same object an extension will receive,
    // so stability has to be a property of the value rather than of etiquette.
    expect(() => {
      config.port = 2;
    }).toThrow(TypeError);
    expect(() => {
      config.upstreams.primary.url = 'https://b';
    }).toThrow(TypeError);
    expect(() => {
      config.tags.push('b');
    }).toThrow(TypeError);

    const entry = snapshot.get('gateway');
    expect(entry).toEqual({
      kind: 'config',
      source: 'test',
      config: { port: 1, upstreams: { primary: { url: 'https://a' } }, tags: ['a'] },
    });
    expect(Object.isFrozen(entry)).toBe(true);
    expect(entry?.kind === 'config' && Object.isFrozen(entry.config)).toBe(true);
  });

  it('freezes a configuration tree too deep for a recursive walk', () => {
    // Bounded by the file size cap, not by the call stack: a file well under the
    // limit can still nest deeper than a recursive freeze could follow.
    const depth = 200_000;
    const root: Record<string, JsonValue> = {};
    let leaf = root;
    for (let level = 0; level < depth; level += 1) {
      const next: Record<string, JsonValue> = {};
      leaf.child = next;
      leaf = next;
    }

    const snapshot = createExtensionOperatorConfigSnapshot(
      new Map<string, ExtensionOperatorConfigEntry>([['gateway', { kind: 'config', source: 'test', config: root }]]),
    );

    expect(Object.isFrozen(snapshot.get('gateway'))).toBe(true);
    expect(Object.isFrozen(leaf)).toBe(true);
  });

  it('freezes nested objects even when the caller already froze the root', () => {
    // A host assembling its own layer plausibly hands in a frozen literal. If a
    // frozen container counted as "already walked", every nested object would
    // stay mutable and the stability guarantee would hold only at depth one.
    const nested = { url: 'https://a' };
    const config = Object.freeze({ upstreams: Object.freeze({ primary: nested }) });

    const snapshot = createExtensionOperatorConfigSnapshot(
      new Map<string, ExtensionOperatorConfigEntry>([['gateway', { kind: 'config', source: 'test', config }]]),
    );

    expect(Object.isFrozen(nested)).toBe(true);
    expect(() => {
      nested.url = 'https://b';
    }).toThrow(TypeError);
    expect(snapshot.get('gateway')).toMatchObject({ config: { upstreams: { primary: { url: 'https://a' } } } });
  });

  it('freezes a shared subtree once without revisiting it', () => {
    const shared: Record<string, JsonValue> = { url: 'https://a' };
    const config: Record<string, JsonValue> = { primary: shared, secondary: shared };
    config.self = config;

    createExtensionOperatorConfigSnapshot(
      new Map<string, ExtensionOperatorConfigEntry>([['gateway', { kind: 'config', source: 'test', config }]]),
    );

    expect(Object.isFrozen(shared)).toBe(true);
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('freezes a failure entry without needing a configuration tree', () => {
    const snapshot = createExtensionOperatorConfigSnapshot(
      new Map<string, ExtensionOperatorConfigEntry>([
        ['gateway', { kind: 'failure', source: 'test', reason: 'invalid-json' }],
      ]),
    );

    expect(Object.isFrozen(snapshot.get('gateway'))).toBe(true);
  });
});

describe('warnOnUnappliedExtensionOperatorConfig', () => {
  let warnSpy: MockInstance<typeof console.warn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  /**
   * Build a snapshot holding one usable entry for an extension.
   * @param extensionName - Name the entry is keyed by.
   * @returns Snapshot with exactly that entry.
   */
  function snapshotWithConfigFor(extensionName: string): ReturnType<typeof createExtensionOperatorConfigSnapshot> {
    return createExtensionOperatorConfigSnapshot(
      new Map<string, ExtensionOperatorConfigEntry>([
        [extensionName, { kind: 'config', source: `/home/config/extensions/${extensionName}.json`, config: {} }],
      ]),
    );
  }

  it('reports an entry for an extension that is not loaded', () => {
    warnOnUnappliedExtensionOperatorConfig(snapshotWithConfigFor('gateway'), [{ name: 'other', configSchema: {} }]);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('names extension "gateway", which is not loaded');
  });

  it('reports an entry for a loaded extension that declares no config schema', () => {
    warnOnUnappliedExtensionOperatorConfig(snapshotWithConfigFor('gateway'), [{ name: 'gateway' }]);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('which declares no config schema');
  });

  it('stays silent for a loaded extension that can consume the entry', () => {
    warnOnUnappliedExtensionOperatorConfig(snapshotWithConfigFor('gateway'), [{ name: 'gateway', configSchema: {} }]);

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('leaves an unusable entry for a loaded extension to the activation failure that raises it', () => {
    const snapshot = createExtensionOperatorConfigSnapshot(
      new Map<string, ExtensionOperatorConfigEntry>([
        ['gateway', { kind: 'failure', source: '/home/config/extensions/gateway.json', reason: 'invalid-json' }],
      ]),
    );

    warnOnUnappliedExtensionOperatorConfig(snapshot, [{ name: 'gateway' }]);

    expect(warnSpy).not.toHaveBeenCalled();
  });
});
