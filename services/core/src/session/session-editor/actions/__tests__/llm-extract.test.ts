import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, AgentResolutionSubjects, defineAdapterProviderAuth } from '@makaio/contracts';
import { CredentialRefSchema } from '@makaio/contracts/config';
import { AdapterSubsystemSubjects } from '../../../../adapter-subsystem/namespace.js';
import { ExtractedContextSchema } from '@makaio/services-core/compression/schemas';
import { AdapterRuntimeSubjects } from '@makaio/services-core/adapter-runtime';
import type { SessionMessage } from '@makaio/contracts';
import { createLlmExtractAction, serializeMessagesForExtraction, EXTRACTION_SYSTEM_PROMPT } from '../llm-extract.js';
import { actionRegistry } from '../../action-registry.js';
import { messagesToContextAction } from '../messages-to-context.js';
import { resetBuiltInActionsRegistration } from '../index.js';
import { executePipeline } from '../../pipeline-executor.js';

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

/** Minimal valid ExtractedContext for mock responses */
const MOCK_EXTRACTED_CONTEXT = {
  resolved_items: ['Implemented the feature'],
  known_bugs: [],
  todos: [],
  key_decisions_and_rationale: ['Used factory pattern for testability'],
  technical_details: {
    files: ['src/feature.ts'],
    schemas: {},
    apis: [],
    config: {},
  },
  constraints_and_requirements: [],
  current_state: 'Feature is implemented and tested.',
  roadmap: [],
  data_flows: [],
  component_interactions: {},
  key_files: { 'src/feature.ts': 'Main feature implementation' },
  helpful_hint: [],
};

/**
 * Build a minimal user SessionMessage.
 * @param content - Text content of the message
 * @param messageId - Optional message ID override
 */
function makeUserMessage(content: string, messageId = 'msg-user-1'): SessionMessage {
  return {
    messageId,
    turnId: null,
    sessionId: 's1',
    role: 'user',
    contentText: content,
    blocks: [{ type: 'text', content }],
    timestamp: 1,
  };
}

/**
 * Build a minimal assistant SessionMessage.
 * @param content - Text content of the message
 * @param messageId - Optional message ID override
 */
function makeAssistantMessage(content: string, messageId = 'msg-asst-1'): SessionMessage {
  return {
    messageId,
    turnId: null,
    sessionId: 's1',
    role: 'assistant',
    contentText: content,
    blocks: [{ type: 'text', content }],
    timestamp: 2,
  };
}

// ---------------------------------------------------------------------------
// serializeMessagesForExtraction
// ---------------------------------------------------------------------------

describe('serializeMessagesForExtraction', () => {
  it('wraps user messages in [human] tags and assistant messages in [assistant] tags', () => {
    const messages: SessionMessage[] = [makeUserMessage('hello'), makeAssistantMessage('world')];
    const result = serializeMessagesForExtraction(messages);

    expect(result).toContain('[human]\nhello\n[/human]');
    expect(result).toContain('[assistant]\nworld\n[/assistant]');
    expect(result).toMatch(/^<conversation>/);
    expect(result).toMatch(/<\/conversation>$/);
  });

  it('joins multiple text blocks in one message with newline', () => {
    const message: SessionMessage = {
      messageId: 'm1',
      turnId: null,
      sessionId: 's1',
      role: 'user',
      contentText: 'first\nsecond',
      blocks: [
        { type: 'text', content: 'first' },
        { type: 'text', content: 'second' },
      ],
      timestamp: 1,
    };

    const result = serializeMessagesForExtraction([message]);
    expect(result).toContain('[human]\nfirst\nsecond\n[/human]');
  });

  it('omits reasoning, tool_call, and tool_output blocks', () => {
    const message: SessionMessage = {
      messageId: 'm1',
      turnId: null,
      sessionId: 's1',
      role: 'assistant',
      contentText: 'visible',
      blocks: [
        { type: 'reasoning', content: 'internal reasoning' },
        { type: 'text', content: 'visible' },
        { type: 'tool_call', toolCallId: 'tc1', name: 'bash', args: { command: 'ls' } },
        { type: 'tool_output', toolCallId: 'tc1', output: 'file.ts' },
      ],
      timestamp: 1,
    };

    const result = serializeMessagesForExtraction([message]);
    expect(result).toContain('[assistant]\nvisible\n[/assistant]');
    expect(result).not.toContain('internal reasoning');
    expect(result).not.toContain('bash');
    expect(result).not.toContain('file.ts');
  });

  it('omits messages with no text blocks after filtering', () => {
    const message: SessionMessage = {
      messageId: 'm1',
      turnId: null,
      sessionId: 's1',
      role: 'assistant',
      contentText: '',
      blocks: [{ type: 'tool_call', toolCallId: 'tc1', name: 'bash', args: { command: 'ls' } }],
      timestamp: 1,
    };

    const result = serializeMessagesForExtraction([message]);
    expect(result).toBe('<conversation>\n\n</conversation>');
  });

  it('separates messages with double newlines', () => {
    const messages: SessionMessage[] = [makeUserMessage('question', 'msg-1'), makeAssistantMessage('answer', 'msg-2')];

    const result = serializeMessagesForExtraction(messages);
    expect(result).toContain('[/human]\n\n[assistant]');
  });

  it('returns empty conversation wrapper for empty input', () => {
    const result = serializeMessagesForExtraction([]);
    expect(result).toBe('<conversation>\n\n</conversation>');
  });
});

/**
 * Register one atomic adapter/provider runtime snapshot for inference tests.
 * @param providerConfigId - Config ID returned by the runtime snapshot.
 * @returns Unsubscribe callback.
 */
function registerRuntimeSnapshotHandler(providerConfigId = 'provider-abc'): () => void {
  const method = { owner: 'provider' as const, providerDefinitionId: 'def-anthropic', methodId: 'api-key' };
  const methodDefinition = {
    id: 'api-key',
    mode: 'explicit' as const,
    label: 'API key',
    fields: [
      {
        id: 'apiKey',
        label: 'API key',
        required: true,
        secret: true,
        sourceHints: [{ kind: 'environment' as const, variable: 'ANTHROPIC_API_KEY' }],
      },
    ],
  };
  return MakaioBus.on(AdapterSubsystemSubjects.resolveAdapterRuntimeSnapshot, (ctx) => {
    ctx.setResult({
      status: 'resolved',
      runtime: {
        snapshot: {
          config: {
            id: providerConfigId,
            definitionId: 'def-anthropic',
            name: 'Anthropic Test',
            modelFilterMode: 'show-all',
            isDefault: true,
            enabled: true,
            auth: { mode: 'explicit', method, hasCredentials: true },
          },
          context: {
            state: 'resolved',
            providerConfigId,
            definitionId: 'def-anthropic',
            endpointOverrides: { anthropic: 'https://api.test.example' },
            auth: {
              mode: 'explicit',
              method,
              definition: methodDefinition,
              credentialRefs: { apiKey: CredentialRefSchema.parse('env:ANTHROPIC_API_KEY') },
            },
          },
          definition: {
            id: 'def-anthropic',
            packageName: '@makaio/provider-anthropic',
            name: 'Anthropic',
            availableModels: [],
            authMethods: [methodDefinition],
            defaultModelFilterMode: 'show-all',
            enabled: true,
            createdAt: 1,
            updatedAt: 1,
          },
        },
        adapterName: 'claude-code',
        adapterProviderAuth: defineAdapterProviderAuth({
          bindings: [{ method, deliveries: [{ kind: 'process-env', fields: { apiKey: 'ANTHROPIC_API_KEY' } }] }],
          scrubEnvVars: ['ANTHROPIC_API_KEY'],
        }),
        compatibleProviderAuths: [],
        runtimePackages: {
          adapter: { packageName: '@makaio/adapter-claude-code' },
          provider: { packageName: '@makaio/provider-anthropic', definitionId: 'def-anthropic' },
        },
      },
    });
  });
}

// ---------------------------------------------------------------------------
// createLlmExtractAction — no-op paths (no bus calls)
// ---------------------------------------------------------------------------

describe('createLlmExtractAction — no-op paths', () => {
  const messages: SessionMessage[] = [makeUserMessage('hello')];
  const action = createLlmExtractAction(MakaioBus);

  it('returns pass-through when options is undefined', async () => {
    const result = await action.execute(messages);
    expect(result).toEqual({ kind: 'messages', messages });
  });

  it('returns pass-through when options has no virtualModelId key', async () => {
    const result = await action.execute(messages, {});
    expect(result).toEqual({ kind: 'messages', messages });
  });

  it('returns pass-through when virtualModelId is not a string', async () => {
    const result = await action.execute(messages, { virtualModelId: 42 });
    expect(result).toEqual({ kind: 'messages', messages });
  });
});

// ---------------------------------------------------------------------------
// createLlmExtractAction — success path
// ---------------------------------------------------------------------------

describe('createLlmExtractAction — success path', () => {
  const unsubs: Array<() => void> = [];
  let inferPayload: Record<string, unknown> | undefined;

  beforeEach(() => {
    // Register lightweight real handlers that return canned responses.
    unsubs.push(
      MakaioBus.on(AgentResolutionSubjects.resolve, (ctx) => {
        ctx.setResult({
          adapterName: 'claude-code',
          model: 'claude-haiku-4-5',
          providerConfigId: 'provider-abc',
          contextMode: 'fresh',
          compressionMode: 'off',
        });
      }),
    );

    unsubs.push(
      MakaioBus.on(AdapterRuntimeSubjects.resolveId, (ctx) => {
        ctx.setResult({ adapterId: 'adapter-uuid-123' });
      }),
    );

    unsubs.push(registerRuntimeSnapshotHandler());

    unsubs.push(
      MakaioBus.on(AdapterSubjects.infer, (ctx) => {
        inferPayload = ctx.payload as Record<string, unknown>;
        ctx.setResult({ text: JSON.stringify(MOCK_EXTRACTED_CONTEXT) });
      }),
    );
  });

  afterEach(() => {
    unsubs.forEach((u) => u());
    unsubs.length = 0;
    inferPayload = undefined;
  });

  it('returns structured context on success', async () => {
    const messages: SessionMessage[] = [
      makeUserMessage('What did we implement?'),
      makeAssistantMessage('We implemented the feature.'),
    ];
    const action = createLlmExtractAction(MakaioBus);

    const result = await action.execute(messages, { virtualModelId: 'cheap-extraction' });

    expect(result.kind).toBe('context');
    if (result.kind !== 'context') return;

    // Verify providerContext was resolved and passed to the infer call.
    expect(inferPayload).toMatchObject({
      providerContext: expect.objectContaining({
        state: 'resolved',
        providerConfigId: 'provider-abc',
        definitionId: 'def-anthropic',
        auth: expect.objectContaining({
          mode: 'explicit',
          credentialRefs: { apiKey: 'env:ANTHROPIC_API_KEY' },
        }),
      }),
    });
    expect(inferPayload).not.toHaveProperty('providerContext.credentials');

    // Validate the returned json passes ExtractedContextSchema
    const parsed = ExtractedContextSchema.safeParse(result.json);
    expect(parsed.success).toBe(true);
    expect((result.json as typeof MOCK_EXTRACTED_CONTEXT).current_state).toBe('Feature is implemented and tested.');
  });

  it('returns a positive tokenEstimate', async () => {
    const messages: SessionMessage[] = [makeUserMessage('hello')];
    const action = createLlmExtractAction(MakaioBus);

    const result = await action.execute(messages, { virtualModelId: 'cheap-extraction' });

    expect(result.kind).toBe('context');
    if (result.kind !== 'context') return;
    expect(result.tokenEstimate).toBeGreaterThan(0);
  });

  it('EXTRACTION_SYSTEM_PROMPT is non-empty', () => {
    expect(EXTRACTION_SYSTEM_PROMPT.length).toBeGreaterThan(0);
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('current_state');
  });
});

// ---------------------------------------------------------------------------
// createLlmExtractAction — graceful degradation
// ---------------------------------------------------------------------------

describe('createLlmExtractAction — graceful degradation', () => {
  const messages: SessionMessage[] = [makeUserMessage('hello')];

  it('returns pass-through when AgentResolutionSubjects.resolve throws', async () => {
    const unsub = MakaioBus.on(AgentResolutionSubjects.resolve, () => {
      throw new Error('Agent resolution not found');
    });
    const action = createLlmExtractAction(MakaioBus);

    const result = await action.execute(messages, { virtualModelId: 'unknown' });
    unsub();

    expect(result).toEqual({ kind: 'messages', messages });
  });

  it('returns pass-through when AdapterRuntimeSubjects.resolveId throws', async () => {
    const unsub1 = MakaioBus.on(AgentResolutionSubjects.resolve, (ctx) => {
      ctx.setResult({ adapterName: 'claude-code', model: 'haiku', contextMode: 'fresh', compressionMode: 'off' });
    });
    const unsub2 = MakaioBus.on(AdapterRuntimeSubjects.resolveId, () => {
      throw new Error('Adapter not registered');
    });

    const action = createLlmExtractAction(MakaioBus);
    const result = await action.execute(messages, { virtualModelId: 'v1' });

    unsub1();
    unsub2();

    expect(result).toEqual({ kind: 'messages', messages });
  });

  it('returns pass-through when provider context resolution fails', async () => {
    const unsub1 = MakaioBus.on(AgentResolutionSubjects.resolve, (ctx) => {
      ctx.setResult({
        adapterName: 'claude-code',
        model: 'haiku',
        providerConfigId: 'missing-provider',
        contextMode: 'fresh',
        compressionMode: 'off',
      });
    });
    const unsub2 = MakaioBus.on(AdapterRuntimeSubjects.resolveId, (ctx) => {
      ctx.setResult({ adapterId: 'adapter-1' });
    });
    const unsub3 = MakaioBus.on(AdapterSubsystemSubjects.resolveAdapterRuntimeSnapshot, (ctx) => {
      ctx.setResult({ status: 'error', code: 'provider-config-not-found' });
    });

    const action = createLlmExtractAction(MakaioBus);
    const result = await action.execute(messages, { virtualModelId: 'v1' });

    unsub1();
    unsub2();
    unsub3();

    expect(result).toEqual({ kind: 'messages', messages });
  });

  // The following tests include providerConfigId in the resolution result and
  // register atomic runtime handlers so the complete adapter/provider
  // compatibility path is exercised — matching production
  // where AgentResolution typically returns a provider config binding.

  it('returns pass-through when AdapterSubjects.infer throws', async () => {
    const unsub1 = MakaioBus.on(AgentResolutionSubjects.resolve, (ctx) => {
      ctx.setResult({
        adapterName: 'claude-code',
        model: 'haiku',
        providerConfigId: 'provider-abc',
        contextMode: 'fresh',
        compressionMode: 'off',
      });
    });
    const unsub2 = MakaioBus.on(AdapterRuntimeSubjects.resolveId, (ctx) => {
      ctx.setResult({ adapterId: 'adapter-1' });
    });
    const providerUnsub = registerRuntimeSnapshotHandler();
    const unsub5 = MakaioBus.on(AdapterSubjects.infer, () => {
      throw new Error('Model quota exceeded');
    });

    const action = createLlmExtractAction(MakaioBus);
    const result = await action.execute(messages, { virtualModelId: 'v1' });

    unsub1();
    unsub2();
    providerUnsub();
    unsub5();

    expect(result).toEqual({ kind: 'messages', messages });
  });

  it('returns pass-through when adapter returns non-JSON text', async () => {
    const unsub1 = MakaioBus.on(AgentResolutionSubjects.resolve, (ctx) => {
      ctx.setResult({
        adapterName: 'claude-code',
        model: 'haiku',
        providerConfigId: 'provider-abc',
        contextMode: 'fresh',
        compressionMode: 'off',
      });
    });
    const unsub2 = MakaioBus.on(AdapterRuntimeSubjects.resolveId, (ctx) => {
      ctx.setResult({ adapterId: 'adapter-1' });
    });
    const providerUnsub = registerRuntimeSnapshotHandler();
    const unsub5 = MakaioBus.on(AdapterSubjects.infer, (ctx) => {
      ctx.setResult({ text: 'Sorry, I cannot help with that.' });
    });

    const action = createLlmExtractAction(MakaioBus);
    const result = await action.execute(messages, { virtualModelId: 'v1' });

    unsub1();
    unsub2();
    providerUnsub();
    unsub5();

    expect(result).toEqual({ kind: 'messages', messages });
  });

  it('returns pass-through when adapter returns partial JSON failing schema validation', async () => {
    const unsub1 = MakaioBus.on(AgentResolutionSubjects.resolve, (ctx) => {
      ctx.setResult({
        adapterName: 'claude-code',
        model: 'haiku',
        providerConfigId: 'provider-abc',
        contextMode: 'fresh',
        compressionMode: 'off',
      });
    });
    const unsub2 = MakaioBus.on(AdapterRuntimeSubjects.resolveId, (ctx) => {
      ctx.setResult({ adapterId: 'adapter-1' });
    });
    const providerUnsub = registerRuntimeSnapshotHandler();
    // Missing required fields like current_state
    const partialJson = { resolved_items: ['something'] };
    const unsub5 = MakaioBus.on(AdapterSubjects.infer, (ctx) => {
      ctx.setResult({ text: JSON.stringify(partialJson) });
    });

    const action = createLlmExtractAction(MakaioBus);
    const result = await action.execute(messages, { virtualModelId: 'v1' });

    unsub1();
    unsub2();
    providerUnsub();
    unsub5();

    expect(result).toEqual({ kind: 'messages', messages });
  });
});

// ---------------------------------------------------------------------------
// Integration: pipeline with llm-extract + messages-to-context fallback
// ---------------------------------------------------------------------------

describe('integration: pipeline with llm-extract and messages-to-context', () => {
  const unsubs: Array<() => void> = [];

  beforeEach(() => {
    actionRegistry.reset();
    resetBuiltInActionsRegistration();
    actionRegistry.register(messagesToContextAction);
  });

  afterEach(() => {
    unsubs.forEach((u) => u());
    unsubs.length = 0;
    actionRegistry.reset();
    resetBuiltInActionsRegistration();
  });

  // This test intentionally omits providerConfigId from the resolution result
  // to exercise the fallback path where no provider config binding exists.
  // The llm-extract action handles this gracefully by skipping runtime-context resolution.
  it('terminates pipeline at llm-extract when extraction succeeds', async () => {
    // Register the llm-extract action in the registry
    const llmExtractAction = createLlmExtractAction(MakaioBus);
    actionRegistry.register(llmExtractAction);

    unsubs.push(
      MakaioBus.on(AgentResolutionSubjects.resolve, (ctx) => {
        ctx.setResult({ adapterName: 'claude-code', model: 'haiku', contextMode: 'fresh', compressionMode: 'off' });
      }),
      MakaioBus.on(AdapterRuntimeSubjects.resolveId, (ctx) => {
        ctx.setResult({ adapterId: 'adapter-1' });
      }),
      MakaioBus.on(AdapterSubjects.infer, (ctx) => {
        ctx.setResult({ text: JSON.stringify(MOCK_EXTRACTED_CONTEXT) });
      }),
    );

    const messages: SessionMessage[] = [makeUserMessage('hello'), makeAssistantMessage('world')];
    const pipeline = [
      { actionId: 'llm-extract', options: { virtualModelId: 'cheap-extraction' } },
      { actionId: 'messages-to-context' },
    ];

    const result = await executePipeline(messages, pipeline);

    expect(result.contextJson).toBeDefined();
    expect((result.contextJson as typeof MOCK_EXTRACTED_CONTEXT).current_state).toBe(
      'Feature is implemented and tested.',
    );
    // messages-to-context did NOT run — no type: 'compressed-messages' key
    expect(result.contextJson).not.toHaveProperty('type', 'compressed-messages');
    expect(result.messages).toEqual([]);
  });

  it('threads pipeline context sessionId into VirtualModel resolve request', async () => {
    const llmExtractAction = createLlmExtractAction(MakaioBus);
    actionRegistry.register(llmExtractAction);

    let resolvePayload: unknown;
    unsubs.push(
      MakaioBus.on(AgentResolutionSubjects.resolve, (ctx) => {
        resolvePayload = ctx.payload;
        ctx.setResult({ adapterName: 'claude-code', model: 'haiku', contextMode: 'fresh', compressionMode: 'off' });
      }),
      MakaioBus.on(AdapterRuntimeSubjects.resolveId, (ctx) => {
        ctx.setResult({ adapterId: 'adapter-1' });
      }),
      MakaioBus.on(AdapterSubjects.infer, (ctx) => {
        ctx.setResult({ text: JSON.stringify(MOCK_EXTRACTED_CONTEXT) });
      }),
    );

    const messages: SessionMessage[] = [makeUserMessage('hello')];
    const pipeline = [{ actionId: 'llm-extract', options: { virtualModelId: 'cheap-extraction' } }];

    const result = await executePipeline(messages, pipeline, { sessionId: 'session-from-context' });

    expect(result.contextJson).toBeDefined();
    expect(resolvePayload).toMatchObject({
      selection: { kind: 'virtual-model', virtualModelId: 'cheap-extraction' },
      context: { sessionId: 'session-from-context' },
    });
  });

  it('falls through to messages-to-context when llm-extract has no virtualModelId', async () => {
    const llmExtractAction = createLlmExtractAction(MakaioBus);
    actionRegistry.register(llmExtractAction);

    const messages: SessionMessage[] = [makeUserMessage('hello')];
    const pipeline = [
      { actionId: 'llm-extract' }, // no options.virtualModelId
      { actionId: 'messages-to-context' },
    ];

    const result = await executePipeline(messages, pipeline);

    expect(result.contextJson).toBeDefined();
    expect(result.contextJson).toHaveProperty('type', 'compressed-messages');
  });

  it('falls through to messages-to-context when llm-extract infer throws', async () => {
    const llmExtractAction = createLlmExtractAction(MakaioBus);
    actionRegistry.register(llmExtractAction);

    unsubs.push(
      MakaioBus.on(AgentResolutionSubjects.resolve, (ctx) => {
        ctx.setResult({ adapterName: 'claude-code', model: 'haiku', contextMode: 'fresh', compressionMode: 'off' });
      }),
      MakaioBus.on(AdapterRuntimeSubjects.resolveId, (ctx) => {
        ctx.setResult({ adapterId: 'adapter-1' });
      }),
      MakaioBus.on(AdapterSubjects.infer, () => {
        throw new Error('timeout');
      }),
    );

    const messages: SessionMessage[] = [makeUserMessage('hello')];
    const pipeline = [
      { actionId: 'llm-extract', options: { virtualModelId: 'cheap-extraction' } },
      { actionId: 'messages-to-context' },
    ];

    const result = await executePipeline(messages, pipeline);

    expect(result.contextJson).toBeDefined();
    expect(result.contextJson).toHaveProperty('type', 'compressed-messages');
  });
});

// ---------------------------------------------------------------------------
// Action registration
// ---------------------------------------------------------------------------

describe('registerBuiltInActions with bus', () => {
  beforeEach(() => {
    actionRegistry.reset();
    resetBuiltInActionsRegistration();
  });

  afterEach(() => {
    actionRegistry.reset();
    resetBuiltInActionsRegistration();
  });

  it('registers llm-extract when bus is provided', async () => {
    const { registerBuiltInActions } = await import('../index.js');
    registerBuiltInActions(MakaioBus);

    const action = actionRegistry.get('llm-extract');
    expect(action).toBeDefined();
    expect(action?.id).toBe('llm-extract');
    expect(action?.category).toBe('extraction');
  });

  it('does not register llm-extract when no bus provided', async () => {
    const { registerBuiltInActions } = await import('../index.js');
    registerBuiltInActions();

    const action = actionRegistry.get('llm-extract');
    expect(action).toBeUndefined();
  });

  it('still registers all other built-in actions without bus', async () => {
    const { registerBuiltInActions } = await import('../index.js');
    registerBuiltInActions();

    expect(actionRegistry.get('strip-reasoning')).toBeDefined();
    expect(actionRegistry.get('strip-tool-outputs')).toBeDefined();
    expect(actionRegistry.get('messages-to-context')).toBeDefined();
    expect(actionRegistry.get('llm-summarize')).toBeDefined();
  });
});
