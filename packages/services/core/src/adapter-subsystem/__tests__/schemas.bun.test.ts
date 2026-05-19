import { describe, expect, it } from 'bun:test';
import { CredentialRefSchema } from '@makaio/contracts/config';
import { AdapterSubsystemSubjects } from '../namespace.js';
import { AdapterSubsystemSchemas } from '../schemas.js';

const sampleProviderConfigRecord = {
  id: 'anthropic-work',
  definitionId: 'anthropic',
  name: 'Anthropic Work',
  endpointOverrides: {
    anthropic: 'https://api.anthropic.com',
  },
  modelVisibility: {
    'claude-sonnet-4-6': 'enabled' as const,
  },
  modelFilterMode: 'show-all' as const,
  isDefault: true,
  enabled: true,
  isSentinel: false,
  hasCredentials: true,
  sourceRef: 'account-manager:["claude-code","account-123"]',
};

const sampleBindingRecord = {
  adapterName: 'claude-agent-sdk',
  providerConfigId: 'anthropic-work',
  isDefault: true,
};

const sampleAdapterFileConfig = {
  name: 'claude-agent-sdk',
  enabled: true,
  displayName: 'Claude Agent SDK',
  settings: {
    maxConcurrency: 5,
  },
  bindings: [sampleBindingRecord],
};

const sampleProviderContext = {
  providerConfigId: 'anthropic-work',
  definitionId: 'anthropic',
  endpointOverrides: {
    anthropic: 'https://api.anthropic.com',
  },
  credentialRefs: {
    apiKey: CredentialRefSchema.parse('stored:providerConfig:anthropic-work:apiKey'),
  },
  credentialEnvVars: {
    apiKey: 'ANTHROPIC_API_KEY',
  },
};

const sampleEffectiveAdapter = {
  name: 'claude-agent-sdk',
  displayName: 'Claude Agent SDK',
  description: 'SDK-based adapter for Claude flows',
  enabled: true,
  configCount: 1,
  readiness: 'ready' as const,
  supportsLogImport: false,
  helpLinks: [{ label: 'Docs', url: 'https://example.com/docs' }],
  instructions: 'Follow the setup guide.',
  clientId: 'claude-code',
  protocol: 'anthropic' as const,
  providerDefinitionIds: ['anthropic'],
};

const requestResponseCases = [
  {
    subject: 'getAdapterConfig',
    request: { name: 'claude-agent-sdk' },
    response: { config: sampleAdapterFileConfig },
  },
  {
    subject: 'listAdapterConfigs',
    request: {},
    response: { configs: [sampleAdapterFileConfig] },
  },
  {
    subject: 'getProviderConfig',
    request: { id: 'anthropic-work' },
    response: { config: sampleProviderConfigRecord },
  },
  {
    subject: 'listProviderConfigs',
    request: { enabled: true },
    response: { configs: [sampleProviderConfigRecord] },
  },
  {
    subject: 'listProviderConfigsByDefinition',
    request: { definitionId: 'anthropic' },
    response: { configs: [sampleProviderConfigRecord] },
  },
  {
    subject: 'listBindings',
    request: { adapterName: 'claude-agent-sdk' },
    response: { bindings: [sampleBindingRecord] },
  },
  {
    subject: 'listBindingsByConfig',
    request: { providerConfigId: 'anthropic-work' },
    response: { bindings: [sampleBindingRecord] },
  },
  {
    subject: 'getDefaultBinding',
    request: { adapterName: 'claude-agent-sdk' },
    response: { binding: sampleBindingRecord },
  },
  {
    subject: 'findConfigForDefinitionAndAdapter',
    request: { definitionId: 'anthropic', adapterName: 'claude-agent-sdk' },
    response: { config: sampleProviderConfigRecord },
  },
  {
    subject: 'buildProviderContext',
    request: { providerConfigId: 'anthropic-work' },
    response: { context: sampleProviderContext },
  },
  {
    subject: 'listAdapters',
    request: {},
    response: { adapters: [sampleEffectiveAdapter] },
  },
  {
    subject: 'createProviderConfig',
    request: {
      definitionId: 'anthropic',
      name: 'Anthropic Work',
      credentialRefs: { backupKey: CredentialRefSchema.parse('stored:providerConfig:anthropic-work:backupKey') },
      endpointOverrides: { anthropic: 'https://api.anthropic.com' },
      modelVisibility: { 'claude-sonnet-4-6': 'enabled' as const },
      modelFilterMode: 'allowlist' as const,
    },
    response: { config: sampleProviderConfigRecord },
  },
  {
    subject: 'updateProviderConfig',
    request: {
      id: 'anthropic-work',
      patch: {
        name: 'Anthropic Work',
        endpointOverrides: { anthropic: 'https://api.anthropic.com' },
        modelVisibility: { 'claude-sonnet-4-6': 'disabled' as const },
        enabled: false,
      },
    },
    response: { config: sampleProviderConfigRecord },
  },
  {
    subject: 'setProviderConfigCredentialRefs',
    request: {
      id: 'anthropic-work',
      credentialRefs: {
        apiKey: CredentialRefSchema.parse('env:ANTHROPIC_API_KEY'),
      },
    },
    response: { config: sampleProviderConfigRecord },
  },
  {
    subject: 'deleteProviderConfig',
    request: { id: 'anthropic-work' },
    response: { deleted: true },
  },
  {
    subject: 'setDefaultProviderConfig',
    request: { id: 'anthropic-work' },
    response: { config: sampleProviderConfigRecord },
  },
  {
    subject: 'setModelFilterMode',
    request: { id: 'anthropic-work', modelFilterMode: 'allowlist' as const, preferredModel: 'claude-sonnet-4-6' },
    response: { config: sampleProviderConfigRecord },
  },
  {
    subject: 'setAdapterConfig',
    request: {
      name: 'claude-agent-sdk',
      patch: {
        displayName: 'Claude Agent SDK',
        description: 'SDK-based adapter for Claude flows',
        helpLinks: [{ label: 'Docs', url: 'https://example.com/docs' }],
        instructions: 'Follow the setup guide.',
        clientId: 'claude-code',
        protocol: 'anthropic',
        providerDefinitionIds: ['anthropic'],
        settings: { maxConcurrency: 10 },
        enabled: false,
      },
    },
    response: { config: sampleAdapterFileConfig },
  },
  {
    subject: 'setAdapterEnabled',
    request: { name: 'claude-agent-sdk', enabled: false },
    response: { success: true },
  },
  {
    subject: 'bind',
    request: { adapterName: 'claude-agent-sdk', providerConfigId: 'anthropic-work' },
    response: { binding: sampleBindingRecord },
  },
  {
    subject: 'unbind',
    request: { adapterName: 'claude-agent-sdk', providerConfigId: 'anthropic-work' },
    response: {},
  },
  {
    subject: 'setDefaultBinding',
    request: { adapterName: 'claude-agent-sdk', providerConfigId: 'anthropic-work' },
    response: {},
  },
  {
    subject: 'ensureReady',
    request: {},
    response: { ready: true },
  },
] as const;

const eventCases = [
  { subject: 'providerConfig.created', payload: sampleProviderConfigRecord },
  { subject: 'providerConfig.updated', payload: sampleProviderConfigRecord },
  { subject: 'providerConfig.deleted', payload: { id: 'anthropic-work' } },
  {
    subject: 'providerConfig.defaultChanged',
    payload: { definitionId: 'anthropic', configId: 'anthropic-work' as string | null },
  },
  { subject: 'binding.created', payload: sampleBindingRecord },
  {
    subject: 'binding.deleted',
    payload: { adapterName: 'claude-agent-sdk', providerConfigId: 'anthropic-work' },
  },
  {
    subject: 'binding.defaultChanged',
    payload: { adapterName: 'claude-agent-sdk', providerConfigId: 'anthropic-work' },
  },
  { subject: 'ready', payload: {} },
  {
    subject: 'adapter.registered',
    payload: {
      adapterName: 'claude-agent-sdk',
      displayName: 'Claude Agent SDK',
      packageName: '@makaio/adapter-claude-agent-sdk',
      enabled: true,
      initialized: true,
      providerDefinitionIds: ['anthropic'],
    },
  },
] as const;

describe('AdapterSubsystemSchemas', () => {
  it('registers the adapterSubsystem namespace subjects', () => {
    expect(AdapterSubsystemSubjects.listAdapters).toMatchObject({
      subject: 'listAdapters',
      $meta: {
        namespace: 'adapterSubsystem',
      },
    });
    expect(AdapterSubsystemSubjects.providerConfig.created).toMatchObject({
      subject: 'providerConfig.created',
      $meta: {
        namespace: 'adapterSubsystem',
      },
    });
    expect(AdapterSubsystemSubjects.adapter.registered).toMatchObject({
      subject: 'adapter.registered',
      $meta: {
        namespace: 'adapterSubsystem',
      },
    });
  });

  it('iterates the complete schema record', () => {
    const subjects = Object.keys(AdapterSubsystemSchemas);

    expect(subjects).toContain('getAdapterConfig');
    expect(subjects).toContain('listAdapters');
    expect(subjects).toContain('providerConfig.created');
    expect(subjects).toContain('ready');
    expect(subjects).toContain('adapter.registered');
  });

  it('does not register the retired batch adaptersRegistered subject', () => {
    expect('adaptersRegistered' in AdapterSubsystemSchemas).toBe(false);
  });

  it('parses every request/response subject', () => {
    for (const testCase of requestResponseCases) {
      const schema = AdapterSubsystemSchemas[testCase.subject];
      expect('request' in schema).toBe(true);

      const requestResult = schema.request.safeParse(testCase.request);
      const responseResult = schema.response.safeParse(testCase.response);

      expect(requestResult.success, `${testCase.subject} request`).toBe(true);
      expect(responseResult.success, `${testCase.subject} response`).toBe(true);
    }
  });

  it('rejects plaintext credentials on createProviderConfig requests', () => {
    const result = AdapterSubsystemSchemas.createProviderConfig.request.safeParse({
      definitionId: 'anthropic',
      credentials: { apiKey: 'sk-ant-plaintext' },
    });

    expect(result.success).toBe(false);
  });

  it('rejects create input with a caller-supplied id', () => {
    const result = AdapterSubsystemSchemas.createProviderConfig.request.safeParse({
      id: 'anthropic-work',
      definitionId: 'anthropic',
    });

    expect(result.success).toBe(false);
  });

  it('accepts credential refs on createProviderConfig requests', () => {
    const result = AdapterSubsystemSchemas.createProviderConfig.request.safeParse({
      definitionId: 'anthropic',
      credentialRefs: { apiKey: CredentialRefSchema.parse('env:ANTHROPIC_API_KEY') },
    });

    expect(result.success).toBe(true);
  });

  it('rejects create input that mixes raw credentials with credential refs', () => {
    const result = AdapterSubsystemSchemas.createProviderConfig.request.safeParse({
      definitionId: 'anthropic',
      credentials: { apiKey: 'sk-ant-plaintext' },
      credentialRefs: { apiKey: CredentialRefSchema.parse('stored:providerConfig:anthropic-work:apiKey') },
    });

    expect(result.success).toBe(false);
  });

  it('accepts credential refs on setProviderConfigCredentialRefs requests', () => {
    const result = AdapterSubsystemSchemas.setProviderConfigCredentialRefs.request.safeParse({
      id: 'anthropic-work',
      credentialRefs: { apiKey: CredentialRefSchema.parse('stored:providerConfig:anthropic-work:apiKey') },
    });

    expect(result.success).toBe(true);
  });

  it('rejects create input names that violate the canonical provider-config contract', () => {
    const result = AdapterSubsystemSchemas.createProviderConfig.request.safeParse({
      definitionId: 'anthropic',
      name: 'bad::name',
    });

    expect(result.success).toBe(false);
  });

  it('rejects adapter settings with non-JSON values', () => {
    const result = AdapterSubsystemSchemas.setAdapterConfig.request.safeParse({
      name: 'claude-agent-sdk',
      patch: {
        settings: {
          nested: undefined,
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it('accepts the full canonical adapter metadata patch surface', () => {
    const result = AdapterSubsystemSchemas.setAdapterConfig.request.safeParse({
      name: 'claude-agent-sdk',
      patch: {
        displayName: 'Claude Agent SDK',
        description: 'SDK-based adapter for Claude flows',
        helpLinks: [{ label: 'Docs', url: 'https://example.com/docs' }],
        instructions: 'Follow the setup guide.',
        clientId: 'claude-code',
        protocol: 'anthropic',
        providerDefinitionIds: ['anthropic'],
        settings: { maxConcurrency: 10 },
        enabled: true,
      },
    });

    expect(result.success).toBe(true);
  });

  it('rejects modelFilterMode in canonical provider config patches', () => {
    const result = AdapterSubsystemSchemas.updateProviderConfig.request.safeParse({
      id: 'anthropic-work',
      patch: {
        modelFilterMode: 'allowlist',
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects isSentinel in canonical provider config patches', () => {
    const result = AdapterSubsystemSchemas.updateProviderConfig.request.safeParse({
      id: 'anthropic-work',
      patch: {
        isSentinel: true,
      },
    });

    expect(result.success).toBe(false);
  });

  it('parses every event subject', () => {
    for (const testCase of eventCases) {
      const schema = AdapterSubsystemSchemas[testCase.subject];
      expect('request' in schema).toBe(false);

      const result = schema.safeParse(testCase.payload);
      expect(result.success, `${testCase.subject} event`).toBe(true);
    }
  });

  it('does not expose plaintext credentials in the provider config read model', () => {
    const result = AdapterSubsystemSchemas.getProviderConfig.response.safeParse({
      config: {
        ...sampleProviderConfigRecord,
        credentials: { apiKey: 'sk-ant-plaintext' },
      },
    });

    expect(result.success).toBe(false);
  });

  it('does not expose credential refs in the provider config read model', () => {
    const result = AdapterSubsystemSchemas.getProviderConfig.response.safeParse({
      config: {
        ...sampleProviderConfigRecord,
        credentialRefs: { apiKey: CredentialRefSchema.parse('stored:providerConfig:anthropic-work:apiKey') },
      },
    });

    expect(result.success).toBe(false);
  });

  it('does not register the retired provider-config composite subject', () => {
    expect('getProviderConfigWithContext' in AdapterSubsystemSchemas).toBe(false);
    expect('getProviderRuntimeView' in AdapterSubsystemSchemas).toBe(false);
  });
});
