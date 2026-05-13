import { describe, it, expect } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { z } from 'zod';
import { ExtensionSubjects, ExtensionNamespace } from '../observability/extension-namespace.js';
import { ComponentStateSchema } from '../observability/shared-schemas.js';

describe('ExtensionSubjects', () => {
  describe('namespace registration', () => {
    it('registers under the "kernel:extension" domain', () => {
      expect(ExtensionNamespace.name).toBe('kernel:extension');
    });

    it('exposes stateChanged subject', () => {
      expect(ExtensionSubjects.stateChanged).toBeDefined();
    });

    it('exposes list subject', () => {
      expect(ExtensionSubjects.list).toBeDefined();
    });

    it('exposes contribution catalog subject', () => {
      expect(ExtensionSubjects.contributions.catalog).toBeDefined();
    });
  });

  describe('stateChanged event schema', () => {
    it('is registered as an event subject (not a request)', () => {
      const schema = MakaioBus.getSchema(ExtensionSubjects.stateChanged);
      expect(schema).toBeDefined();
      // Event subjects are ZodTypes — they do NOT have request/response keys.
      expect(schema).not.toHaveProperty('request');
      expect(schema).not.toHaveProperty('response');
    });

    it('accepts a valid stateChanged payload', () => {
      const schema = MakaioBus.getSchema(ExtensionSubjects.stateChanged) as z.ZodType;
      const result = schema.safeParse({
        name: 'slash-command',
        displayName: 'Slash Command',
        from: 'discovered',
        to: 'initializing',
      });
      expect(result.success).toBe(true);
    });

    it('accepts an optional error field when transitioning to failed', () => {
      const schema = MakaioBus.getSchema(ExtensionSubjects.stateChanged) as z.ZodType;
      const result = schema.safeParse({
        name: 'docker',
        displayName: 'Docker',
        from: 'initializing',
        to: 'failed',
        error: 'Docker daemon not running',
      });
      expect(result.success).toBe(true);
    });

    it('rejects a payload with an unknown state value', () => {
      const schema = MakaioBus.getSchema(ExtensionSubjects.stateChanged) as z.ZodType;
      const result = schema.safeParse({
        name: 'docker',
        displayName: 'Docker',
        from: 'discovered',
        to: 'migrating', // not a valid ComponentState
      });
      expect(result.success).toBe(false);
    });

    it('rejects importing as a state value (internal coordinator detail, not observable)', () => {
      const schema = MakaioBus.getSchema(ExtensionSubjects.stateChanged) as z.ZodType;
      const result = schema.safeParse({
        name: 'docker',
        displayName: 'Docker',
        from: 'discovered',
        to: 'importing',
      });
      expect(result.success).toBe(false);
    });

    it('rejects a payload missing required fields', () => {
      const schema = MakaioBus.getSchema(ExtensionSubjects.stateChanged) as z.ZodType;
      // Missing `to`
      const result = schema.safeParse({
        name: 'voice',
        displayName: 'Voice Bridge',
        from: 'active',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('list RPC schema', () => {
    it('is registered as a request subject', () => {
      const schema = MakaioBus.getSchema(ExtensionSubjects.list);
      expect(schema).toBeDefined();
      expect(schema).toHaveProperty('request');
      expect(schema).toHaveProperty('response');
    });

    it('accepts an empty request payload', () => {
      const schema = MakaioBus.getSchema(ExtensionSubjects.list) as {
        request: z.ZodType;
        response: z.ZodType;
      };
      expect(schema.request.safeParse({}).success).toBe(true);
    });

    it('accepts a valid list response', () => {
      const schema = MakaioBus.getSchema(ExtensionSubjects.list) as {
        request: z.ZodType;
        response: z.ZodType;
      };
      const result = schema.response.safeParse({
        extensions: [
          { name: 'slash-command', displayName: 'Slash Command', state: 'active', enabled: true },
          { name: 'docker', displayName: 'Docker', state: 'failed', enabled: false, error: 'Not found' },
        ],
      });
      expect(result.success).toBe(true);
    });

    it('rejects a response with an invalid extension state', () => {
      const schema = MakaioBus.getSchema(ExtensionSubjects.list) as {
        request: z.ZodType;
        response: z.ZodType;
      };
      const result = schema.response.safeParse({
        extensions: [{ name: 'voice', displayName: 'Voice', state: 'running', enabled: true }],
      });
      expect(result.success).toBe(false);
    });

    it('rejects a response missing the extensions array', () => {
      const schema = MakaioBus.getSchema(ExtensionSubjects.list) as {
        request: z.ZodType;
        response: z.ZodType;
      };
      expect(schema.response.safeParse({}).success).toBe(false);
    });
  });

  describe('get RPC schema', () => {
    it('is registered as a request subject', () => {
      const schema = MakaioBus.getSchema(ExtensionSubjects.get);
      expect(schema).toBeDefined();
      expect(schema).toHaveProperty('request');
      expect(schema).toHaveProperty('response');
    });

    it('accepts a request payload with a name string', () => {
      const schema = MakaioBus.getSchema(ExtensionSubjects.get) as {
        request: z.ZodType;
        response: z.ZodType;
      };
      expect(schema.request.safeParse({ name: 'my-extension' }).success).toBe(true);
    });

    it('rejects a request payload missing name', () => {
      const schema = MakaioBus.getSchema(ExtensionSubjects.get) as {
        request: z.ZodType;
        response: z.ZodType;
      };
      expect(schema.request.safeParse({}).success).toBe(false);
    });

    it('accepts a valid get response with a wrapped ExtensionInfo', () => {
      const schema = MakaioBus.getSchema(ExtensionSubjects.get) as {
        request: z.ZodType;
        response: z.ZodType;
      };
      const result = schema.response.safeParse({
        extension: {
          name: 'slash-command',
          displayName: 'Slash Command',
          state: 'active',
          enabled: true,
        },
      });
      expect(result.success).toBe(true);
    });

    it('accepts a valid get response with a null extension (not found)', () => {
      const schema = MakaioBus.getSchema(ExtensionSubjects.get) as {
        request: z.ZodType;
        response: z.ZodType;
      };
      const result = schema.response.safeParse({ extension: null });
      expect(result.success).toBe(true);
    });

    it('rejects a response missing the extension wrapper', () => {
      const schema = MakaioBus.getSchema(ExtensionSubjects.get) as {
        request: z.ZodType;
        response: z.ZodType;
      };
      // Flat ExtensionInfo shape (old format) must now be rejected
      const result = schema.response.safeParse({
        name: 'slash-command',
        displayName: 'Slash Command',
        state: 'active',
        enabled: true,
      });
      expect(result.success).toBe(false);
    });

    it('rejects a response with an invalid state inside the extension wrapper', () => {
      const schema = MakaioBus.getSchema(ExtensionSubjects.get) as {
        request: z.ZodType;
        response: z.ZodType;
      };
      const result = schema.response.safeParse({
        extension: {
          name: 'docker',
          displayName: 'Docker',
          state: 'running',
          enabled: false,
        },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('enabledChanged event schema', () => {
    it('is registered as an event subject (not a request)', () => {
      const schema = MakaioBus.getSchema(ExtensionSubjects.enabledChanged);
      expect(schema).toBeDefined();
      expect(schema).not.toHaveProperty('request');
      expect(schema).not.toHaveProperty('response');
    });

    it('accepts a valid enabledChanged payload when enabled is true', () => {
      const schema = MakaioBus.getSchema(ExtensionSubjects.enabledChanged) as z.ZodType;
      expect(schema.safeParse({ name: 'slash-command', enabled: true }).success).toBe(true);
    });

    it('accepts a valid enabledChanged payload when enabled is false', () => {
      const schema = MakaioBus.getSchema(ExtensionSubjects.enabledChanged) as z.ZodType;
      expect(schema.safeParse({ name: 'docker', enabled: false }).success).toBe(true);
    });

    it('rejects a payload missing name', () => {
      const schema = MakaioBus.getSchema(ExtensionSubjects.enabledChanged) as z.ZodType;
      expect(schema.safeParse({ enabled: true }).success).toBe(false);
    });

    it('rejects a payload missing enabled', () => {
      const schema = MakaioBus.getSchema(ExtensionSubjects.enabledChanged) as z.ZodType;
      expect(schema.safeParse({ name: 'docker' }).success).toBe(false);
    });
  });

  describe('contributions.catalog RPC schema', () => {
    it('is registered as a request subject', () => {
      const schema = MakaioBus.getSchema(ExtensionSubjects.contributions.catalog);
      expect(schema).toBeDefined();
      expect(schema).toHaveProperty('request');
      expect(schema).toHaveProperty('response');
    });

    it('accepts an empty request payload', () => {
      const schema = MakaioBus.getSchema(ExtensionSubjects.contributions.catalog) as {
        request: z.ZodType;
        response: z.ZodType;
      };
      expect(schema.request.safeParse({}).success).toBe(true);
    });

    it('accepts serializable provider and client contribution catalog entries', () => {
      const schema = MakaioBus.getSchema(ExtensionSubjects.contributions.catalog) as {
        request: z.ZodType;
        response: z.ZodType;
      };

      const result = schema.response.safeParse({
        providers: [
          {
            packageName: 'provider-extension',
            definition: {
              id: 'openai',
              name: 'OpenAI',
              availableModels: [],
            },
          },
        ],
        clients: [
          {
            packageName: 'client-extension',
            definition: {
              id: 'codex',
              name: 'Codex',
              version: '0.1.0',
              defaultApprovalPolicy: 'full-access',
            },
          },
        ],
      });

      expect(result.success).toBe(true);
    });

    it('rejects catalog entries without package names', () => {
      const schema = MakaioBus.getSchema(ExtensionSubjects.contributions.catalog) as {
        response: z.ZodType;
      };

      expect(
        schema.response.safeParse({
          providers: [{ definition: { id: 'openai', name: 'OpenAI', availableModels: [] } }],
          clients: [],
        }).success,
      ).toBe(false);
    });
  });

  describe('ComponentStateSchema', () => {
    it('accepts all valid observable state values', () => {
      const validStates = ['discovered', 'initializing', 'active', 'failed', 'skipped', 'stopped'] as const;
      for (const state of validStates) {
        expect(ComponentStateSchema.safeParse(state).success).toBe(true);
      }
    });

    it('rejects importing (internal coordinator detail, not an observable state)', () => {
      expect(ComponentStateSchema.safeParse('importing').success).toBe(false);
    });

    it('rejects unknown state values', () => {
      expect(ComponentStateSchema.safeParse('migrating').success).toBe(false);
      expect(ComponentStateSchema.safeParse('ready').success).toBe(false);
      expect(ComponentStateSchema.safeParse('').success).toBe(false);
    });
  });
});
