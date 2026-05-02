import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { defineToolset } from '../define-toolset.js';
import type { Toolset } from '../types.js';

describe('Toolset type', () => {
  it('should accept a toolset with configSchema', () => {
    const configSchema = z.object({
      timeout: z.number().default(30000),
      maxOutputSize: z.number().default(10485760),
    });

    const toolset: Toolset = {
      metadata: {
        name: 'test',
        description: 'Test toolset',
        version: '1.0.0',
      },
      tools: {},
      configSchema,
    };

    expect(toolset.configSchema).toBeDefined();
    expect(toolset.metadata.name).toBe('test');
  });

  it('should accept a toolset without configSchema', () => {
    const toolset: Toolset = {
      metadata: {
        name: 'test',
        description: 'Test toolset',
        version: '1.0.0',
      },
      tools: {},
    };

    expect(toolset.configSchema).toBeUndefined();
  });

  it('should allow defineToolset with configSchema', () => {
    const configSchema = z.object({
      timeout: z.number().default(30000),
    });

    const toolset = defineToolset({
      name: 'test',
      description: 'Test toolset',
      version: '1.0.0',
      tools: [],
      configSchema,
    });

    expect(toolset.configSchema).toBeDefined();
  });
});
