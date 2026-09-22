import { describe, it, expect } from 'vitest';
import {
  decodeExtensionOperatorConfigName,
  encodeExtensionOperatorConfigName,
  EXTENSION_OPERATOR_CONFIG_NAME_UNRESERVED,
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
] as const;

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

  it('accepts a dot-containing name that is not a dot segment', () => {
    expect(decodeExtensionOperatorConfigName('.hidden')).toBe('.hidden');
    expect(decodeExtensionOperatorConfigName('...')).toBe('...');
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

  it('keeps an astral character, which is a well-formed surrogate pair', () => {
    expect(decodeExtensionOperatorConfigName(stemOf('emoji-\u{1F680}'))).toBe('emoji-\u{1F680}');
  });
});
