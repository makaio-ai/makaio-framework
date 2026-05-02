import { describe, it, expect } from 'vitest';
import { parseInstallSource } from '../install-source.js';

describe('parseInstallSource', () => {
  it('should detect relative path starting with ./', () => {
    expect(parseInstallSource('./my-ext').kind).toBe('local');
  });

  it('should detect relative path starting with ../', () => {
    expect(parseInstallSource('../my-ext').kind).toBe('local');
  });

  it('should detect absolute path', () => {
    expect(parseInstallSource('/Users/chris/my-ext').kind).toBe('local');
  });

  it('should detect Windows absolute paths', () => {
    expect(parseInstallSource('C:\\Users\\chris\\my-ext').kind).toBe('local');
    expect(parseInstallSource('\\\\server\\share\\my-ext').kind).toBe('local');
  });

  it('should detect home-relative path', () => {
    expect(parseInstallSource('~/code/my-ext').kind).toBe('local');
  });

  it('should resolve bare home-relative path', () => {
    const result = parseInstallSource('~');
    expect(result.kind).toBe('local');
    expect(result.resolved.startsWith('/')).toBe(true);
  });

  it('should reject unsupported tilde-user paths', () => {
    expect(() => parseInstallSource('~foo/bar')).toThrow('Unsupported home-relative path syntax');
    expect(() => parseInstallSource('~user/code')).toThrow('Unsupported home-relative path syntax');
  });

  it('should detect path to descriptor.json', () => {
    expect(parseInstallSource('./my-ext/descriptor.json').kind).toBe('local');
  });

  it('should detect scoped npm package', () => {
    expect(parseInstallSource('@acme/weather-tools').kind).toBe('npm');
  });

  it('should detect unscoped npm package', () => {
    expect(parseInstallSource('weather-tools').kind).toBe('npm');
  });

  it('should detect npm package with version', () => {
    expect(parseInstallSource('@acme/weather-tools@1.2.0').kind).toBe('npm');
  });

  it('should detect git URL', () => {
    expect(parseInstallSource('git+https://github.com/acme/tools.git').kind).toBe('git');
  });

  it('should preserve raw source string', () => {
    expect(parseInstallSource('@acme/weather-tools@1.2.0').raw).toBe('@acme/weather-tools@1.2.0');
  });

  it('should resolve relative path to absolute resolved path', () => {
    const result = parseInstallSource('./my-ext');
    expect(result.resolved).toMatch(/my-ext$/);
    expect(result.resolved.startsWith('/')).toBe(true);
  });

  it('should resolve home-relative path using os.homedir()', () => {
    const result = parseInstallSource('~/code/my-ext');
    expect(result.resolved.startsWith('/')).toBe(true);
    expect(result.resolved).toContain('code/my-ext');
  });

  it('should keep npm resolved equal to raw', () => {
    const raw = '@acme/weather-tools@1.2.0';
    const result = parseInstallSource(raw);
    expect(result.resolved).toBe(raw);
  });

  it('should keep git resolved equal to raw', () => {
    const raw = 'git+https://github.com/acme/tools.git';
    const result = parseInstallSource(raw);
    expect(result.resolved).toBe(raw);
  });
});
