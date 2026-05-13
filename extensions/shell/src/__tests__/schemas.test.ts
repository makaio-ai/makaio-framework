import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ShellConstraintsSchema, type ShellConstraintsConfig } from '../schemas.js';

describe('ShellConstraintsSchema', () => {
  it('should have correct defaults', () => {
    const result = ShellConstraintsSchema.parse({});

    expect(result.timeout).toBe(30000);
    expect(result.maxOutputSize).toBe(10485760);
    expect(result.maxConcurrentShells).toBe(10);
    expect(result.allowedPaths).toEqual([]);
    expect(result.blockedCommands).toEqual([]);
  });

  it('should accept partial overrides', () => {
    const result = ShellConstraintsSchema.parse({
      timeout: 60000,
      blockedCommands: ['rm -rf'],
    });

    expect(result.timeout).toBe(60000);
    expect(result.blockedCommands).toEqual(['rm -rf']);
    expect(result.maxOutputSize).toBe(10485760); // default
  });

  it('should expose descriptions for UI help text', () => {
    const jsonSchema = z.toJSONSchema(ShellConstraintsSchema);
    const props = (jsonSchema as { properties: Record<string, { description?: string }> }).properties;

    expect(props.timeout.description).toBe('Max execution time in milliseconds');
    expect(props.maxOutputSize.description).toBe('Maximum output buffer in characters');
  });

  it('should export ShellConstraintsConfig type correctly', () => {
    // Verify the type is correctly inferred from the schema
    const config: ShellConstraintsConfig = {
      timeout: 5000,
      maxOutputSize: 1024,
      maxConcurrentShells: 5,
      allowedPaths: ['/tmp'],
      blockedCommands: ['rm'],
    };

    // Type check: all properties should be accessible with correct types
    expect(typeof config.timeout).toBe('number');
    expect(typeof config.maxOutputSize).toBe('number');
    expect(typeof config.maxConcurrentShells).toBe('number');
    expect(Array.isArray(config.allowedPaths)).toBe(true);
    expect(Array.isArray(config.blockedCommands)).toBe(true);
  });
});
