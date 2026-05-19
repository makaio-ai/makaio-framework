/**
 * Tests for {@link detectClients} and {@link resolveSelectedExtensionPackages}.
 *
 * Uses real filesystem I/O under per-test temporary directories to exercise
 * detection logic without mocking `fs.access`.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { CLIENT_CATALOG } from '../detect/client-catalog.js';
import { detectClients, resolveSelectedExtensionPackages } from '../detect/detect-clients.js';
import type { SetupClientEntry } from '../types.js';

// ---------------------------------------------------------------------------
// Temp directory lifecycle
// ---------------------------------------------------------------------------

let tmpDir: string;
let originalPath: string | undefined;
let originalPathCapitalized: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-detect-clients-'));
  originalPath = process.env['PATH'];
  originalPathCapitalized = process.env['Path'];
});

afterEach(async () => {
  if (originalPath === undefined) {
    delete process.env['PATH'];
  } else {
    process.env['PATH'] = originalPath;
  }
  if (originalPathCapitalized === undefined) {
    delete process.env['Path'];
  } else {
    process.env['Path'] = originalPathCapitalized;
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// CLIENT_CATALOG shape tests
// ---------------------------------------------------------------------------

describe('CLIENT_CATALOG', () => {
  it('has exactly 5 entries', () => {
    expect(CLIENT_CATALOG).toHaveLength(5);
  });

  it('each entry has required fields with non-empty values', () => {
    for (const entry of CLIENT_CATALOG) {
      expect(entry.clientId).toBeTruthy();
      expect(entry.displayName).toBeTruthy();
      expect(entry.binaryName).toBeTruthy();
      expect(entry.detectPaths.length).toBeGreaterThan(0);
      expect(entry.extensionPackages.length).toBeGreaterThan(0);
    }
  });

  it('has unique clientIds', () => {
    const ids = CLIENT_CATALOG.map((e) => e.clientId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('contains entries for the five expected clients', () => {
    const ids = CLIENT_CATALOG.map((e) => e.clientId);
    expect(ids).toContain('claude-code');
    expect(ids).toContain('codex');
    expect(ids).toContain('gemini');
    expect(ids).toContain('qwen');
    expect(ids).toContain('github-copilot');
  });
});

// ---------------------------------------------------------------------------
// detectClients tests
// ---------------------------------------------------------------------------

describe('detectClients', () => {
  /**
   * Build a minimal catalog entry for testing.
   * @param clientId - Unique identifier.
   * @param detectPaths - Paths to probe.
   * @returns A minimal SetupClientEntry.
   */
  function makeEntry(clientId: string, detectPaths: readonly string[]): SetupClientEntry {
    return {
      clientId,
      displayName: clientId,
      binaryName: clientId,
      detectPaths,
      extensionPackages: [`@makaio/client-${clientId}`],
    };
  }

  it('returns detected=true when a detect path exists', async () => {
    const dir = path.join(tmpDir, 'client-a');
    await fs.mkdir(dir);
    const catalog: readonly SetupClientEntry[] = [makeEntry('a', [dir])];

    const results = await detectClients(catalog);

    expect(results).toHaveLength(1);
    expect(results[0].detected).toBe(true);
    expect(results[0].entry.clientId).toBe('a');
  });

  it('returns detected=false when no detect path exists', async () => {
    const nonExistent = path.join(tmpDir, 'not-here');
    const catalog: readonly SetupClientEntry[] = [makeEntry('b', [nonExistent])];

    const results = await detectClients(catalog);

    expect(results).toHaveLength(1);
    expect(results[0].detected).toBe(false);
  });

  it('returns detected=true when at least one detectPath exists', async () => {
    const exists = path.join(tmpDir, 'one-exists');
    await fs.mkdir(exists);
    const missing = path.join(tmpDir, 'missing');
    const catalog: readonly SetupClientEntry[] = [makeEntry('c', [missing, exists])];

    const results = await detectClients(catalog);

    expect(results[0].detected).toBe(true);
  });

  it('returns detected=true when the binary is present on PATH', async () => {
    const binDir = path.join(tmpDir, 'bin');
    await fs.mkdir(binDir);
    const binaryPath = path.join(binDir, 'makaio-test-client');
    await fs.writeFile(binaryPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    process.env['PATH'] = binDir;

    const catalog: readonly SetupClientEntry[] = [makeEntry('path-client', [path.join(tmpDir, 'missing-config')])];
    const results = await detectClients([
      {
        ...catalog[0],
        binaryName: 'makaio-test-client',
      },
    ]);

    expect(results[0].detected).toBe(true);
  });

  it('reads PATH case-insensitively for Windows-style copied environments', async () => {
    const binDir = path.join(tmpDir, 'bin-path-key');
    await fs.mkdir(binDir);
    const binaryPath = path.join(binDir, 'makaio-path-key-client');
    await fs.writeFile(binaryPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    delete process.env['PATH'];
    process.env['Path'] = binDir;

    const results = await detectClients([
      {
        ...makeEntry('path-key-client', [path.join(tmpDir, 'missing-config')]),
        binaryName: 'makaio-path-key-client',
      },
    ]);

    expect(results[0].detected).toBe(true);
  });

  it('returns all catalog entries with correct detected flags', async () => {
    const dirExists = path.join(tmpDir, 'present');
    await fs.mkdir(dirExists);
    const dirMissing = path.join(tmpDir, 'absent');

    const catalog: readonly SetupClientEntry[] = [makeEntry('present', [dirExists]), makeEntry('absent', [dirMissing])];

    const results = await detectClients(catalog);

    expect(results).toHaveLength(2);
    const byId = Object.fromEntries(results.map((r) => [r.entry.clientId, r]));
    expect(byId['present'].detected).toBe(true);
    expect(byId['absent'].detected).toBe(false);
  });

  it('preserves catalog order in results', async () => {
    const paths = await Promise.all(
      ['x', 'y', 'z'].map(async (id) => {
        const p = path.join(tmpDir, id);
        await fs.mkdir(p);
        return p;
      }),
    );

    const catalog: readonly SetupClientEntry[] = paths.map((p, i) => makeEntry(String(i), [p]));

    const results = await detectClients(catalog);

    expect(results.map((r) => r.entry.clientId)).toEqual(['0', '1', '2']);
  });
});

// ---------------------------------------------------------------------------
// resolveSelectedExtensionPackages tests
// ---------------------------------------------------------------------------

describe('resolveSelectedExtensionPackages', () => {
  const catalog: readonly SetupClientEntry[] = [
    {
      clientId: 'alpha',
      displayName: 'Alpha',
      binaryName: 'alpha',
      detectPaths: [],
      extensionPackages: ['@pkg/alpha-core', '@pkg/shared'],
    },
    {
      clientId: 'beta',
      displayName: 'Beta',
      binaryName: 'beta',
      detectPaths: [],
      extensionPackages: ['@pkg/beta-core', '@pkg/shared'],
    },
    {
      clientId: 'gamma',
      displayName: 'Gamma',
      binaryName: 'gamma',
      detectPaths: [],
      extensionPackages: ['@pkg/gamma-core'],
    },
  ];

  it('returns packages for selected clients', () => {
    const result = resolveSelectedExtensionPackages(catalog, ['alpha']);
    expect(result).toEqual(['@pkg/alpha-core', '@pkg/shared']);
  });

  it('deduplicates packages across selected clients', () => {
    const result = resolveSelectedExtensionPackages(catalog, ['alpha', 'beta']);
    // @pkg/shared appears in both but should appear only once
    expect(result.filter((p) => p === '@pkg/shared')).toHaveLength(1);
  });

  it('preserves catalog order, not selectedIds order', () => {
    // Pass beta before alpha; catalog has alpha first
    const result = resolveSelectedExtensionPackages(catalog, ['beta', 'alpha']);
    // Alpha packages should come before beta in output (catalog order)
    const alphaIdx = result.indexOf('@pkg/alpha-core');
    const betaIdx = result.indexOf('@pkg/beta-core');
    expect(alphaIdx).toBeLessThan(betaIdx);
  });

  it('skips unselected clients', () => {
    const result = resolveSelectedExtensionPackages(catalog, ['gamma']);
    expect(result).not.toContain('@pkg/alpha-core');
    expect(result).not.toContain('@pkg/beta-core');
    expect(result).toContain('@pkg/gamma-core');
  });

  it('returns empty array for empty selection', () => {
    const result = resolveSelectedExtensionPackages(catalog, []);
    expect(result).toEqual([]);
  });
});
