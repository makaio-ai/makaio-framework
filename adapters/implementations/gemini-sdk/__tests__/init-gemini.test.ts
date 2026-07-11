import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Config } from '@google/gemini-cli-core';
import { filterToolDeclarations, initGemini, type GeminiInitConfig } from '../src/utils/init-gemini.js';

type GeminiToolsArg = Array<{ functionDeclarations: Array<{ name: string }> }>;
type GeminiChatCtor = (config: Config, systemPrompt: string, tools: GeminiToolsArg) => void;

/**
 * Build a minimal Gemini config for init tests.
 * @param declarations - Function declarations returned by the tool registry.
 */
function makeGeminiConfig(declarations: Array<{ name?: string }>): GeminiInitConfig {
  return {
    refreshAuth: vi.fn().mockResolvedValue(undefined),
    initialize: vi.fn().mockResolvedValue(undefined),
    getToolRegistry: () => ({
      getFunctionDeclarations: () => declarations,
    }),
    getUserMemory: vi.fn(() => ''),
  };
}

const { geminiChatCtor, getCoreSystemPromptMock } = vi.hoisted(() => {
  return {
    geminiChatCtor: vi.fn<GeminiChatCtor>(),
    getCoreSystemPromptMock: vi.fn(() => 'base system prompt'),
  };
});

vi.mock('@google/gemini-cli-core', () => {
  class GeminiChat {
    public constructor(config: Config, systemPrompt: string, tools: GeminiToolsArg) {
      geminiChatCtor(config, systemPrompt, tools);
    }
  }

  return {
    GeminiChat,
    getCoreSystemPrompt: getCoreSystemPromptMock,
    AuthType: {
      USE_GEMINI: 'USE_GEMINI',
    },
  };
});

describe('filterToolDeclarations', () => {
  it('excludes unnamed declarations and harness-disabled native tools', () => {
    const declarations = [{ name: 'read_file' }, { name: undefined }, { name: 'run_shell_command' }];
    expect(filterToolDeclarations(declarations, ['run_shell_command'])).toEqual([{ name: 'read_file' }]);
  });

  it('keeps named declarations that are not disabled', () => {
    const declarations = [{ name: 'read_file' }, { name: 'write_file' }];
    expect(filterToolDeclarations(declarations, [])).toEqual([{ name: 'read_file' }, { name: 'write_file' }]);
  });
});

describe('initGemini', () => {
  beforeEach(() => {
    geminiChatCtor.mockClear();
    getCoreSystemPromptMock.mockClear();
  });

  it('creates GeminiChat instance', async () => {
    const geminiConfig = makeGeminiConfig([{ name: 'read_file' }, { name: 'run_shell_command' }]);
    await initGemini(geminiConfig, ['run_shell_command'], { apiKey: 'test-key' });

    expect(geminiChatCtor.mock.calls.length).toBe(1);
    expect(getCoreSystemPromptMock).toHaveBeenCalledTimes(1);
  });

  it('uses Gemini API auth when a non-empty apiKey is provided', async () => {
    const geminiConfig = makeGeminiConfig([{ name: 'read_file' }]);
    await initGemini(geminiConfig, [], { apiKey: '  test-key  ' });

    expect(geminiConfig.refreshAuth).toHaveBeenCalledWith('USE_GEMINI', 'test-key');
  });

  it('throws when an explicit apiKey is empty', async () => {
    const geminiConfig = makeGeminiConfig([{ name: 'read_file' }]);

    await expect(initGemini(geminiConfig, [], { apiKey: '' })).rejects.toThrow(
      'Gemini API key was provided but is empty or whitespace-only.',
    );
  });

  it('throws when an explicit apiKey is whitespace-only', async () => {
    const geminiConfig = makeGeminiConfig([{ name: 'read_file' }]);

    await expect(initGemini(geminiConfig, [], { apiKey: '   ' })).rejects.toThrow(
      'Gemini API key was provided but is empty or whitespace-only.',
    );
  });
});
