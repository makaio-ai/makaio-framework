import { describe, expect, it } from 'vitest';
import osStub, { constants, EOL, homedir, networkInterfaces, platform, tmpdir, type } from '../src/renderer/os-stub.js';

describe('os-stub', () => {
  describe('named exports', () => {
    it('type() returns "Browser"', () => {
      expect(type()).toBe('Browser');
    });

    it('platform() returns "browser"', () => {
      expect(platform()).toBe('browser');
    });

    it('homedir() returns "/"', () => {
      expect(homedir()).toBe('/');
    });

    it('tmpdir() returns "/tmp"', () => {
      expect(tmpdir()).toBe('/tmp');
    });

    it('networkInterfaces() returns an empty object', () => {
      expect(networkInterfaces()).toEqual({});
    });

    it('EOL is "\\n"', () => {
      expect(EOL).toBe('\n');
    });

    it('constants has a signals sub-object', () => {
      expect(constants).toHaveProperty('signals');
      expect(constants.signals).toEqual({});
    });

    it('constants has an errno sub-object', () => {
      expect(constants).toHaveProperty('errno');
      expect(constants.errno).toEqual({});
    });
  });

  describe('default export', () => {
    it('default export type() matches the named export', () => {
      expect(osStub.type()).toBe(type());
    });

    it('default export platform() matches the named export', () => {
      expect(osStub.platform()).toBe(platform());
    });

    it('default export homedir() matches the named export', () => {
      expect(osStub.homedir()).toBe(homedir());
    });

    it('default export tmpdir() matches the named export', () => {
      expect(osStub.tmpdir()).toBe(tmpdir());
    });

    it('default export networkInterfaces() matches the named export', () => {
      expect(osStub.networkInterfaces()).toEqual(networkInterfaces());
    });

    it('default export EOL matches the named export', () => {
      expect(osStub.EOL).toBe(EOL);
    });

    it('default export constants matches the named export', () => {
      expect(osStub.constants).toBe(constants);
    });
  });
});
