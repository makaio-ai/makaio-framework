import { describe, it, expect } from 'vitest';
import {
  decodeExtensionOperatorConfigName,
  encodeExtensionOperatorConfigName,
  EXTENSION_OPERATOR_CONFIG_FILE_SUFFIX,
  EXTENSION_OPERATOR_CONFIG_NAME_UNRESERVED,
  MAX_OPERATOR_CONFIG_FILE_NAME_BYTES,
} from '../extension-operator-config-name.js';

/** Extension names spanning every shape the manifest name rule accepts. */
const ROUND_TRIP_NAMES = [
  'gateway',
  'account-manager',
  'my_extension',
  'com.example.tools',
  'Gateway',
  '@acme/weather-tools',
  '@acme/tools.v2',
  'name with spaces',
  'ünïcödé-extension',
  '日本語',
  'percent%name',
  'plus+name',
  '.hidden',
  '...',
] as const;

/**
 * Longest stem the encoding may produce, given the file name bound.
 *
 * Restated from the two constants rather than written out, so a change to
 * either is a change to what this test expects.
 */
const MAX_STEM_LENGTH = MAX_OPERATOR_CONFIG_FILE_NAME_BYTES - EXTENSION_OPERATOR_CONFIG_FILE_SUFFIX.length;

/**
 * Encode a name the test states is addressable, failing loudly when it is not.
 * @param name - Extension name the test expects to have a file stem.
 * @returns That name's file stem.
 */
function stemOf(name: string): string {
  const stem = encodeExtensionOperatorConfigName(name);
  if (stem === undefined) throw new Error(`expected "${name}" to be addressable`);
  return stem;
}

describe('extension operator config name encoding', () => {
  it('leaves an unscoped name of unreserved characters unchanged', () => {
    expect(encodeExtensionOperatorConfigName('gateway')).toBe('gateway');
    expect(encodeExtensionOperatorConfigName('com.example_tools-v2')).toBe('com.example_tools-v2');
  });

  it('collapses a scoped name into a single path segment', () => {
    expect(encodeExtensionOperatorConfigName('@acme/weather-tools')).toBe('%40acme%2Fweather-tools');
  });

  it.each(ROUND_TRIP_NAMES)('round-trips %s', (name) => {
    expect(decodeExtensionOperatorConfigName(stemOf(name))).toBe(name);
  });

  it.each(ROUND_TRIP_NAMES)('produces a stem free of path separators for %s', (name) => {
    const stem = stemOf(name);
    for (const char of stem) {
      expect(char === '%' || EXTENSION_OPERATOR_CONFIG_NAME_UNRESERVED.test(char)).toBe(true);
    }
    expect(stem).not.toMatch(/[/\\:]/);
  });

  it('escapes with uppercase hex digits', () => {
    expect(encodeExtensionOperatorConfigName('a b')).toBe('a%20b');
  });

  it.each([
    ['a lowercase escape', '%40acme%2fweather-tools'],
    ['an escape for a character that needs none', '%67ateway'],
    ['a truncated escape', 'gateway%2'],
    ['a non-hex escape', 'gate%zzway'],
    ['an unescaped separator', 'acme/tools'],
    ['an unescaped colon', 'c:tools'],
    ['a current-directory segment', '.'],
    ['a parent-directory segment', '..'],
    ['an empty stem', ''],
  ])('rejects %s', (_label, stem) => {
    expect(decodeExtensionOperatorConfigName(stem)).toBeUndefined();
  });

  it('rejects an escape sequence that is not valid UTF-8', () => {
    expect(decodeExtensionOperatorConfigName('%FF')).toBeUndefined();
  });

  it('escapes a leading dot so no stem it produces is a hidden file', () => {
    expect(encodeExtensionOperatorConfigName('.hidden')).toBe('%2Ehidden');
    expect(encodeExtensionOperatorConfigName('...')).toBe('%2E..');
  });

  it('keeps dots that are not leading verbatim', () => {
    expect(encodeExtensionOperatorConfigName('com.example.tools')).toBe('com.example.tools');
  });

  it.each([
    ['a stem spelled with a literal leading dot', '.hidden'],
    ['a stem that is only literal dots', '...'],
    ['platform bookkeeping that survives the suffix check', '.DS_Store'],
  ])('rejects %s, which the encoding cannot have produced', (_label, stem) => {
    expect(decodeExtensionOperatorConfigName(stem)).toBeUndefined();
  });

  it('gives a name no stem once its file name would pass the component limit', () => {
    expect(stemOf('a'.repeat(MAX_STEM_LENGTH))).toHaveLength(MAX_STEM_LENGTH);
    expect(encodeExtensionOperatorConfigName('a'.repeat(MAX_STEM_LENGTH + 1))).toBeUndefined();
  });

  it('measures the bound on the encoded name, not on the name as typed', () => {
    // 43 two-byte characters are 43 characters and 258 encoded ones.
    const name = 'ü'.repeat(43);
    expect(name).toHaveLength(43);
    expect(encodeExtensionOperatorConfigName(name)).toBeUndefined();
  });

  it('never produces a file name above the bound for a name it accepts', () => {
    // 41 two-byte characters encode to 246 characters, the longest such name
    // that still fits.
    for (const name of [...ROUND_TRIP_NAMES, 'a'.repeat(MAX_STEM_LENGTH), 'ü'.repeat(41)]) {
      const fileName = `${stemOf(name)}${EXTENSION_OPERATOR_CONFIG_FILE_SUFFIX}`;
      expect(new TextEncoder().encode(fileName).byteLength).toBeLessThanOrEqual(MAX_OPERATOR_CONFIG_FILE_NAME_BYTES);
    }
  });

  it.each([
    ['a lone high surrogate', '\uD800'],
    ['a lone low surrogate', '\uDFFF'],
    ['a name that only partly pairs its surrogates', 'tools-\uD83D'],
    ['an empty name', ''],
    ['a current-directory name', '.'],
    ['a parent-directory name', '..'],
  ])('encodes %s to no stem at all', (_label, name) => {
    expect(encodeExtensionOperatorConfigName(name)).toBeUndefined();
  });

  it('keeps distinct names on distinct stems where UTF-8 encoding would fold them', () => {
    // `TextEncoder` turns an unpaired surrogate into U+FFFD, so encoding both
    // names would hand them the same file and a stem would no longer say which
    // extension it belongs to. The ill-formed one gets no stem instead.
    expect(encodeExtensionOperatorConfigName('\uD800')).toBeUndefined();
    expect(stemOf('\uFFFD')).toBe('%EF%BF%BD');
    expect(decodeExtensionOperatorConfigName('%EF%BF%BD')).toBe('\uFFFD');
  });

  it('keeps a leading byte-order mark, which is a character of the name and not a document marker', () => {
    // A decoder that consumed it would answer a different name, the round-trip
    // would fail, and the correctly named file would be rejected.
    const name = '﻿tools';
    expect(stemOf(name)).toBe('%EF%BB%BFtools');
    expect(decodeExtensionOperatorConfigName('%EF%BB%BFtools')).toBe(name);
    expect(decodeExtensionOperatorConfigName('%EF%BB%BFtools')).not.toBe('tools');
  });

  it('keeps an astral character, which is a well-formed surrogate pair', () => {
    expect(decodeExtensionOperatorConfigName(stemOf('emoji-\u{1F680}'))).toBe('emoji-\u{1F680}');
  });
});
