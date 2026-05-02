import { describe, it, expect } from 'vitest';
import { parseBusUrl } from '../utils/url-config.js';

describe('parseBusUrl', () => {
  describe('default (no env var)', () => {
    it('returns localhost URL with explicit port 6252', () => {
      const config = parseBusUrl(undefined);

      expect(config.href).toBe('ws://localhost:6252/bus');
      expect(config.port).toBe(6252);
      expect(config.isDefault).toBe(true);
    });
  });

  describe('user-provided URL with explicit port', () => {
    it('uses the specified port', () => {
      const config = parseBusUrl('wss://bus.example.com:9000/bus');

      expect(config.href).toBe('wss://bus.example.com:9000/bus');
      expect(config.port).toBe(9000);
      expect(config.isDefault).toBe(false);
    });

    it('handles non-standard ws:// port', () => {
      const config = parseBusUrl('ws://localhost:3000/bus');

      expect(config.href).toBe('ws://localhost:3000/bus');
      expect(config.port).toBe(3000);
      expect(config.isDefault).toBe(false);
    });
  });

  describe('user-provided URL without port (protocol default)', () => {
    it('preserves wss:// URL and returns undefined port', () => {
      const config = parseBusUrl('wss://bus.example.com/bus');

      // URL should be preserved as-is (port 443 is implicit for wss://)
      expect(config.href).toBe('wss://bus.example.com/bus');
      expect(config.port).toBeUndefined();
      expect(config.isDefault).toBe(false);
    });

    it('preserves ws:// URL and returns undefined port', () => {
      const config = parseBusUrl('ws://bus.example.com/bus');

      // URL should be preserved as-is (port 80 is implicit for ws://)
      expect(config.href).toBe('ws://bus.example.com/bus');
      expect(config.port).toBeUndefined();
      expect(config.isDefault).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('handles trailing slash variations', () => {
      const config = parseBusUrl('wss://bus.example.com:6252/bus/');

      expect(config.href).toBe('wss://bus.example.com:6252/bus/');
      expect(config.port).toBe(6252);
    });

    it('throws on empty string (invalid URL)', () => {
      // Empty string creates invalid URL - callers should pass undefined instead
      expect(() => parseBusUrl('')).toThrow('Invalid URL');
    });
  });
});
