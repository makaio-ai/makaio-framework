import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { computeConsentHash, loadConsentDocument } from '../consent/consent-document.js';
import { readConsentRecord, writeConsentRecord } from '../consent/consent-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string | null = null;

async function makeTempDir(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), 'makaio-consent-test-'));
  return tempDir;
}

afterEach(async () => {
  if (tempDir !== null) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

// ---------------------------------------------------------------------------
// computeConsentHash
// ---------------------------------------------------------------------------

describe('computeConsentHash', () => {
  it('returns a 64-char hex string', () => {
    const hash = computeConsentHash('hello world');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('returns consistent output for the same input', () => {
    const content = 'some terms content';
    expect(computeConsentHash(content)).toBe(computeConsentHash(content));
  });

  it('returns different output for different input', () => {
    const hashA = computeConsentHash('content A');
    const hashB = computeConsentHash('content B');
    expect(hashA).not.toBe(hashB);
  });
});

// ---------------------------------------------------------------------------
// loadConsentDocument
// ---------------------------------------------------------------------------

describe('loadConsentDocument', () => {
  it('returns text, version, and hash', async () => {
    const doc = await loadConsentDocument();
    expect(typeof doc.text).toBe('string');
    expect(doc.text.length).toBeGreaterThan(0);
    expect(typeof doc.version).toBe('string');
    expect(doc.version.length).toBeGreaterThan(0);
    expect(doc.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('hash matches computing hash of returned text', async () => {
    const doc = await loadConsentDocument();
    expect(doc.hash).toBe(computeConsentHash(doc.text));
  });

  it('text contains expected terms content', async () => {
    const doc = await loadConsentDocument();
    expect(doc.text).toContain('Makaio Terms of Use');
  });
});

// ---------------------------------------------------------------------------
// readConsentRecord
// ---------------------------------------------------------------------------

describe('readConsentRecord', () => {
  it('returns null when consent.json does not exist', async () => {
    const dir = await makeTempDir();
    const result = await readConsentRecord(dir);
    expect(result).toBeNull();
  });

  it('throws when the home path cannot be read as a directory', async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, 'not-a-directory');
    await writeFile(filePath, 'plain file', 'utf8');

    await expect(readConsentRecord(filePath)).rejects.toThrow();
  });

  it('returns null for invalid JSON', async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, 'consent.json'), 'not valid json', 'utf8');
    const result = await readConsentRecord(dir);
    expect(result).toBeNull();
  });

  it('returns null for invalid hash format', async () => {
    const dir = await makeTempDir();
    const invalid = {
      acceptedAt: new Date().toISOString(),
      documentHash: 'not-a-valid-hash',
      documentVersion: '2026-05-17',
    };
    await writeFile(join(dir, 'consent.json'), JSON.stringify(invalid), 'utf8');
    const result = await readConsentRecord(dir);
    expect(result).toBeNull();
  });

  it('returns parsed record for a valid consent file', async () => {
    const dir = await makeTempDir();
    const record = {
      acceptedAt: '2026-05-17T10:00:00.000Z',
      documentHash: 'a'.repeat(64),
      documentVersion: '2026-05-17',
    };
    await writeFile(join(dir, 'consent.json'), JSON.stringify(record), 'utf8');
    const result = await readConsentRecord(dir);
    expect(result).toEqual(record);
  });
});

// ---------------------------------------------------------------------------
// writeConsentRecord
// ---------------------------------------------------------------------------

describe('writeConsentRecord', () => {
  it('creates the consent.json file', async () => {
    const dir = await makeTempDir();
    const record = {
      acceptedAt: '2026-05-17T10:00:00.000Z',
      documentHash: 'b'.repeat(64),
      documentVersion: '2026-05-17',
    };
    await writeConsentRecord(dir, record);
    const raw = await readFile(join(dir, 'consent.json'), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    expect(parsed).toEqual(record);
  });

  it('sets file mode to 0600 (owner read/write only)', async () => {
    const dir = await makeTempDir();
    const record = {
      acceptedAt: '2026-05-17T10:00:00.000Z',
      documentHash: 'c'.repeat(64),
      documentVersion: '2026-05-17',
    };
    await writeConsentRecord(dir, record);
    const stats = await stat(join(dir, 'consent.json'));
    // Mask to last 9 permission bits
    const mode = stats.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('leaves no temporary files behind', async () => {
    const dir = await makeTempDir();
    const record = {
      acceptedAt: '2026-05-17T10:00:00.000Z',
      documentHash: 'd'.repeat(64),
      documentVersion: '2026-05-17',
    };
    await writeConsentRecord(dir, record);
    const files = await readdir(dir);
    expect(files).toEqual(['consent.json']);
  });

  it('creates makaioHome before writing the first consent record', async () => {
    const dir = await makeTempDir();
    const missingHome = join(dir, 'nested', '.makaio');
    const record = {
      acceptedAt: '2026-05-17T10:00:00.000Z',
      documentHash: 'f'.repeat(64),
      documentVersion: '2026-05-17',
    };

    await writeConsentRecord(missingHome, record);

    const raw = await readFile(join(missingHome, 'consent.json'), 'utf8');
    expect(JSON.parse(raw) as unknown).toEqual(record);
  });
});

// ---------------------------------------------------------------------------
// Round-trip
// ---------------------------------------------------------------------------

describe('round-trip: write then read', () => {
  it('returns the same record after write + read', async () => {
    const dir = await makeTempDir();
    const record = {
      acceptedAt: '2026-05-17T12:34:56.789Z',
      documentHash: 'e'.repeat(64),
      documentVersion: '2026-05-17',
    };
    await writeConsentRecord(dir, record);
    const result = await readConsentRecord(dir);
    expect(result).toEqual(record);
  });
});
