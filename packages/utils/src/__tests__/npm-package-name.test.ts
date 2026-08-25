import { describe, expect, it } from 'vitest';
import { isNpmPackageName, NPM_PACKAGE_NAME_MAX_LENGTH } from '../npm-package-name.js';

describe('isNpmPackageName', () => {
  it.each(['zod', '@makaio/extension-workflow', 'package.name_1'])('accepts the registry name %j', (value) => {
    expect(isNpmPackageName(value)).toBe(true);
  });

  it.each([
    '',
    '@scope',
    'UPPER',
    '../local-package',
    'package@1.0.0',
    'git+https://example.test/package',
  ])('rejects the npm specifier rather than a package name: %j', (value) => {
    expect(isNpmPackageName(value)).toBe(false);
  });

  it.each([
    'con',
    'aux',
    'prn',
    'nul',
    'com0',
    'com9.js',
    'lpt1.js',
    '@scope/con',
    'package.',
    '@scope/package.',
  ])('rejects the Windows-unportable package name %j', (value) => {
    expect(isNpmPackageName(value)).toBe(false);
  });

  it.each(['console', 'lpt.js', '@con/package'])('accepts a name that only resembles a Windows device', (value) => {
    expect(isNpmPackageName(value)).toBe(true);
  });

  it('keeps syntax and npm’s 214-character length limit separately reusable', () => {
    expect(isNpmPackageName('a'.repeat(NPM_PACKAGE_NAME_MAX_LENGTH))).toBe(true);
    expect(isNpmPackageName('a'.repeat(NPM_PACKAGE_NAME_MAX_LENGTH + 1))).toBe(true);
    expect(NPM_PACKAGE_NAME_MAX_LENGTH).toBe(214);
  });
});
