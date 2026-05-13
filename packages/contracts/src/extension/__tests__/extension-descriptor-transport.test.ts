import { describe, expect, it } from 'vitest';
import { ExtensionDescriptorSchema } from '../extension-descriptor.js';

const base = {
  name: 'test-ext',
  displayName: 'Test Extension',
  version: '1.0.0',
  makaio: { framework: '>=0.1.0' },
};

describe('ExtensionDescriptorSchema — detached transport', () => {
  it('accepts detached with a valid bus-stdio transport', () => {
    const result = ExtensionDescriptorSchema.safeParse({
      ...base,
      execution: 'detached',
      transport: { type: 'bus-stdio', command: 'node' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts detached with transport but no entrypoints', () => {
    const result = ExtensionDescriptorSchema.safeParse({
      ...base,
      execution: 'detached',
      transport: { type: 'bus-stdio', command: 'node' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.entrypoints).toBeUndefined();
    }
  });

  it('rejects detached without transport', () => {
    const result = ExtensionDescriptorSchema.safeParse({
      ...base,
      execution: 'detached',
    });
    expect(result.success).toBe(false);
  });

  it('accepts embedded with entrypoints', () => {
    const result = ExtensionDescriptorSchema.safeParse({
      ...base,
      entrypoints: { server: true },
    });
    expect(result.success).toBe(true);
  });

  it('rejects embedded without entrypoints', () => {
    const result = ExtensionDescriptorSchema.safeParse(base);
    expect(result.success).toBe(false);
  });

  it('accepts bus-stdio transport with command', () => {
    const result = ExtensionDescriptorSchema.safeParse({
      ...base,
      execution: 'detached',
      transport: { type: 'bus-stdio', command: './bin/ext' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts bus-websocket transport with command', () => {
    const result = ExtensionDescriptorSchema.safeParse({
      ...base,
      execution: 'detached',
      transport: { type: 'bus-websocket', command: './bin/ext' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts mcp-stdio transport with command', () => {
    const result = ExtensionDescriptorSchema.safeParse({
      ...base,
      execution: 'detached',
      transport: { type: 'mcp-stdio', command: './bin/ext' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects bus-stdio transport without command', () => {
    const result = ExtensionDescriptorSchema.safeParse({
      ...base,
      execution: 'detached',
      transport: { type: 'bus-stdio' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects bus-websocket transport without command', () => {
    const result = ExtensionDescriptorSchema.safeParse({
      ...base,
      execution: 'detached',
      transport: { type: 'bus-websocket' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects mcp-stdio transport without command', () => {
    const result = ExtensionDescriptorSchema.safeParse({
      ...base,
      execution: 'detached',
      transport: { type: 'mcp-stdio' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects detached descriptor that also declares entrypoints', () => {
    const result = ExtensionDescriptorSchema.safeParse({
      ...base,
      execution: 'detached',
      transport: { type: 'bus-stdio', command: 'node' },
      entrypoints: { server: true },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('entrypoints'))).toBe(true);
    }
  });

  it('rejects embedded descriptor that also declares a transport', () => {
    const result = ExtensionDescriptorSchema.safeParse({
      ...base,
      entrypoints: { server: true },
      transport: { type: 'bus-stdio', command: 'node' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('transport'))).toBe(true);
    }
  });
});
