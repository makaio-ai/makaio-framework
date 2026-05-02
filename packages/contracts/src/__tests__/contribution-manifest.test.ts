import { describe, expect, it } from 'vitest';
import {
  AdapterManifestSchema,
  ClientManifestSchema,
  ContributionManifestSchema,
  ExtensionManifestSchema,
  ProviderManifestSchema,
} from '@makaio/contracts/extension';
import { ExtensionDescriptorSchema } from '../extension/extension-descriptor.js';

// ---------------------------------------------------------------------------
// AdapterManifest
// ---------------------------------------------------------------------------

describe('AdapterManifestSchema', () => {
  it('parses an adapter with simple protocol strings', () => {
    const result = AdapterManifestSchema.safeParse({
      name: 'claude-code',
      protocols: ['anthropic'],
    });

    expect(result.success).toBe(true);
  });

  it('parses an adapter with multiple simple protocol strings', () => {
    const result = AdapterManifestSchema.safeParse({
      name: 'dual-protocol',
      protocols: ['anthropic', 'openai'],
    });

    expect(result.success).toBe(true);
  });

  it('parses an adapter with protocol config objects', () => {
    const result = AdapterManifestSchema.safeParse({
      name: 'custom-endpoint',
      protocols: [{ anthropic: { endpoint: 'https://custom.host/v1' } }],
    });

    expect(result.success).toBe(true);
  });

  it('parses an adapter with mixed simple strings and config objects', () => {
    const result = AdapterManifestSchema.safeParse({
      name: 'mixed',
      protocols: ['openai', { anthropic: { endpoint: 'https://custom.host/v1' } }],
    });

    expect(result.success).toBe(true);
  });

  it('parses an adapter with protocol config objects containing no endpoint', () => {
    const result = AdapterManifestSchema.safeParse({
      name: 'no-endpoint',
      protocols: [{ anthropic: {} }],
    });

    expect(result.success).toBe(true);
  });

  it('parses an adapter with client refs using semver ranges', () => {
    const result = AdapterManifestSchema.safeParse({
      name: 'claude-code',
      protocols: ['anthropic'],
      clients: [
        { id: 'claude-code', version: '^1.5.0' },
        { id: 'helper-bin', version: '>=2.0.0' },
      ],
    });

    expect(result.success).toBe(true);
  });

  it('parses an adapter with all optional fields', () => {
    const result = AdapterManifestSchema.safeParse({
      name: 'full-adapter',
      displayName: 'Full Adapter',
      description: 'An adapter with all fields',
      protocols: ['anthropic'],
      clients: [{ id: 'my-client', version: '*' }],
      defaultProvider: 'anthropic',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('full-adapter');
      expect(result.data.displayName).toBe('Full Adapter');
      expect(result.data.defaultProvider).toBe('anthropic');
    }
  });

  it('rejects an adapter with no protocols', () => {
    const result = AdapterManifestSchema.safeParse({
      name: 'no-protocols',
      protocols: [],
    });

    expect(result.success).toBe(false);
  });

  it('rejects an adapter with missing protocols field', () => {
    const result = AdapterManifestSchema.safeParse({
      name: 'missing-protocols',
    });

    expect(result.success).toBe(false);
  });

  it('rejects an adapter with an invalid protocol string', () => {
    const result = AdapterManifestSchema.safeParse({
      name: 'bad-protocol',
      protocols: ['unknown-protocol'],
    });

    expect(result.success).toBe(false);
  });

  it('rejects an adapter with a protocol config object with no protocol keys', () => {
    const result = AdapterManifestSchema.safeParse({
      name: 'empty-config',
      protocols: [{}],
    });

    expect(result.success).toBe(false);
  });

  it('rejects an adapter with a non-URL endpoint in protocol config', () => {
    const result = AdapterManifestSchema.safeParse({
      name: 'bad-url',
      protocols: [{ anthropic: { endpoint: 'not-a-url' } }],
    });

    expect(result.success).toBe(false);
  });

  it('rejects an adapter with missing name', () => {
    const result = AdapterManifestSchema.safeParse({
      protocols: ['anthropic'],
    });

    expect(result.success).toBe(false);
  });

  it('rejects an adapter with empty name', () => {
    const result = AdapterManifestSchema.safeParse({
      name: '',
      protocols: ['anthropic'],
    });

    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ClientManifest
// ---------------------------------------------------------------------------

describe('ClientManifestSchema', () => {
  it('parses a client with all fields', () => {
    const result = ClientManifestSchema.safeParse({
      id: 'claude-code',
      name: 'Claude Code',
      description: 'The Claude Code CLI binary',
      binaryName: 'claude',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe('claude-code');
      expect(result.data.name).toBe('Claude Code');
      expect(result.data.description).toBe('The Claude Code CLI binary');
      expect(result.data.binaryName).toBe('claude');
    }
  });

  it('parses a client with only required fields (id and name)', () => {
    const result = ClientManifestSchema.safeParse({
      id: 'minimal-client',
      name: 'Minimal Client',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.description).toBeUndefined();
      expect(result.data.binaryName).toBeUndefined();
    }
  });

  it('rejects a client with missing id', () => {
    const result = ClientManifestSchema.safeParse({
      name: 'No ID Client',
    });

    expect(result.success).toBe(false);
  });

  it('rejects a client with missing name', () => {
    const result = ClientManifestSchema.safeParse({
      id: 'no-name',
    });

    expect(result.success).toBe(false);
  });

  it('rejects a client with empty id', () => {
    const result = ClientManifestSchema.safeParse({
      id: '',
      name: 'Client',
    });

    expect(result.success).toBe(false);
  });

  it('rejects a client with empty name', () => {
    const result = ClientManifestSchema.safeParse({
      id: 'my-client',
      name: '',
    });

    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ProviderManifest
// ---------------------------------------------------------------------------

describe('ProviderManifestSchema', () => {
  it('parses a provider with all fields', () => {
    const result = ProviderManifestSchema.safeParse({
      id: 'anthropic',
      name: 'Anthropic',
      description: 'Official Anthropic API',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe('anthropic');
      expect(result.data.name).toBe('Anthropic');
      expect(result.data.description).toBe('Official Anthropic API');
    }
  });

  it('parses a provider with only required fields (id and name)', () => {
    const result = ProviderManifestSchema.safeParse({
      id: 'minimal-provider',
      name: 'Minimal Provider',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.description).toBeUndefined();
    }
  });

  it('rejects a provider with missing id', () => {
    const result = ProviderManifestSchema.safeParse({
      name: 'No ID Provider',
    });

    expect(result.success).toBe(false);
  });

  it('rejects a provider with missing name', () => {
    const result = ProviderManifestSchema.safeParse({
      id: 'no-name',
    });

    expect(result.success).toBe(false);
  });

  it('rejects a provider with empty id', () => {
    const result = ProviderManifestSchema.safeParse({
      id: '',
      name: 'Provider',
    });

    expect(result.success).toBe(false);
  });

  it('rejects a provider with empty name', () => {
    const result = ProviderManifestSchema.safeParse({
      id: 'my-provider',
      name: '',
    });

    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ContributionManifest
// ---------------------------------------------------------------------------

describe('ContributionManifestSchema', () => {
  it('parses a contribution manifest with both adapters and clients', () => {
    const result = ContributionManifestSchema.safeParse({
      adapters: [{ name: 'claude-code', protocols: ['anthropic'] }],
      clients: [{ id: 'claude-code', name: 'Claude Code' }],
    });

    expect(result.success).toBe(true);
  });

  it('parses a contribution manifest with only adapters', () => {
    const result = ContributionManifestSchema.safeParse({
      adapters: [{ name: 'my-adapter', protocols: ['openai'] }],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.clients).toBeUndefined();
    }
  });

  it('parses a contribution manifest with only clients', () => {
    const result = ContributionManifestSchema.safeParse({
      clients: [{ id: 'my-client', name: 'My Client' }],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.adapters).toBeUndefined();
    }
  });

  it('parses a contribution manifest with only providers', () => {
    const result = ContributionManifestSchema.safeParse({
      providers: [{ id: 'anthropic', name: 'Anthropic' }],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.adapters).toBeUndefined();
      expect(result.data.clients).toBeUndefined();
      expect(result.data.providers).toHaveLength(1);
    }
  });

  it('parses an empty contribution manifest (all fields optional)', () => {
    const result = ContributionManifestSchema.safeParse({});

    expect(result.success).toBe(true);
  });

  it('rejects a contribution manifest with invalid adapter entry', () => {
    const result = ContributionManifestSchema.safeParse({
      adapters: [{ name: '', protocols: ['anthropic'] }],
    });

    expect(result.success).toBe(false);
  });

  it('rejects a contribution manifest with invalid client entry', () => {
    const result = ContributionManifestSchema.safeParse({
      clients: [{ id: '', name: 'No ID' }],
    });

    expect(result.success).toBe(false);
  });

  it('rejects duplicate adapter contribution names with exact issue paths and messages', () => {
    const result = ContributionManifestSchema.safeParse({
      adapters: [
        { name: 'claude-code', protocols: ['anthropic'] },
        { name: 'openai-node', protocols: ['openai'] },
        { name: 'claude-code', protocols: ['openai'] },
        { name: 'openai-node', protocols: ['anthropic'] },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toEqual([
        { path: ['adapters'], message: 'Duplicate adapter contribution identifier "claude-code"' },
        { path: ['adapters'], message: 'Duplicate adapter contribution identifier "openai-node"' },
      ]);
    }
  });

  it('rejects duplicate client contribution IDs with exact issue paths and messages', () => {
    const result = ContributionManifestSchema.safeParse({
      clients: [
        { id: 'claude-code', name: 'Claude Code' },
        { id: 'openai-node', name: 'OpenAI' },
        { id: 'claude-code', name: 'Claude Code Duplicate' },
        { id: 'openai-node', name: 'OpenAI Duplicate' },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toEqual([
        { path: ['clients'], message: 'Duplicate client contribution identifier "claude-code"' },
        { path: ['clients'], message: 'Duplicate client contribution identifier "openai-node"' },
      ]);
    }
  });

  it('rejects duplicate provider contribution IDs with exact issue paths and messages', () => {
    const result = ContributionManifestSchema.safeParse({
      providers: [
        { id: 'anthropic', name: 'Anthropic' },
        { id: 'openai', name: 'OpenAI' },
        { id: 'anthropic', name: 'Anthropic Duplicate' },
        { id: 'openai', name: 'OpenAI Duplicate' },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toEqual([
        { path: ['providers'], message: 'Duplicate provider contribution identifier "anthropic"' },
        { path: ['providers'], message: 'Duplicate provider contribution identifier "openai"' },
      ]);
    }
  });
});

// ---------------------------------------------------------------------------
// ExtensionManifest integration
// ---------------------------------------------------------------------------

describe('ExtensionManifestSchema with contributions field', () => {
  const baseManifest = {
    name: 'my-extension',
    displayName: 'My Extension',
  };

  it('parses a manifest with a contributions field', () => {
    const result = ExtensionManifestSchema.safeParse({
      ...baseManifest,
      contributions: {
        adapters: [{ name: 'my-adapter', protocols: ['anthropic'] }],
        clients: [{ id: 'my-client', name: 'My Client', binaryName: 'my-bin' }],
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contributions?.adapters?.[0]?.name).toBe('my-adapter');
      expect(result.data.contributions?.clients?.[0]?.id).toBe('my-client');
    }
  });

  it('parses a manifest without a contributions field (backwards compatible)', () => {
    const result = ExtensionManifestSchema.safeParse(baseManifest);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contributions).toBeUndefined();
    }
  });

  it('rejects a manifest with an invalid contributions value', () => {
    const result = ExtensionManifestSchema.safeParse({
      ...baseManifest,
      contributions: 'not-an-object',
    });

    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ExtensionDescriptor integration (inherits via ExtensionManifest)
// ---------------------------------------------------------------------------

describe('ExtensionDescriptorSchema with contributions field', () => {
  const baseDescriptor = {
    name: 'my-extension',
    displayName: 'My Extension',
    version: '1.0.0',
    makaio: { minVersion: '2.0.0' },
    entrypoints: { server: true },
  };

  it('parses a descriptor with a contributions field', () => {
    const result = ExtensionDescriptorSchema.safeParse({
      ...baseDescriptor,
      contributions: {
        adapters: [
          {
            name: 'claude-code',
            displayName: 'Claude Code Adapter',
            protocols: ['anthropic', { openai: { endpoint: 'https://api.openai.com/v1' } }],
            clients: [{ id: 'claude-code', version: '^1.5.0' }],
            defaultProvider: 'anthropic',
          },
        ],
        clients: [{ id: 'claude-code', name: 'Claude Code', binaryName: 'claude' }],
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contributions?.adapters?.[0]?.name).toBe('claude-code');
      expect(result.data.contributions?.clients?.[0]?.binaryName).toBe('claude');
    }
  });

  it('parses a descriptor without a contributions field (backwards compatible)', () => {
    const result = ExtensionDescriptorSchema.safeParse(baseDescriptor);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contributions).toBeUndefined();
    }
  });
});
