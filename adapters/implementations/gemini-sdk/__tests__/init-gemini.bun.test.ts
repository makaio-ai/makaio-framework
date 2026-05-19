/// <reference types="bun-types" />
import { describe, expect, it, mock, beforeEach } from 'bun:test';
import type { Config } from '@google/gemini-cli-core';
import {
  buildGeminiAuthOptions,
  filterToolDeclarations,
  initGemini,
  type GeminiInitConfig,
} from '../src/utils/init-gemini.js';

type GeminiToolsArg = Array<{ functionDeclarations: Array<{ name: string }> }>;
type GeminiChatCtor = (config: Config, systemPrompt: string, tools: GeminiToolsArg) => void;

/**
 * Build a minimal Gemini config for init tests.
 * @param declarations - Function declarations returned by the tool registry.
 */
function makeGeminiConfig(declarations: Array<{ name?: string }>): GeminiInitConfig {
  return {
    refreshAuth: mock().mockResolvedValue(undefined),
    initialize: mock().mockResolvedValue(undefined),
    getToolRegistry: () => ({
      getFunctionDeclarations: () => declarations,
    }),
    getUserMemory: mock(() => ''),
  };
}

const geminiChatCtor = mock<GeminiChatCtor>();
const getCoreSystemPromptMock = mock(() => 'base system prompt');

mock.module('@google/gemini-cli-core', () => {
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
      LOGIN_WITH_GOOGLE: 'LOGIN_WITH_GOOGLE',
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

describe('buildGeminiAuthOptions', () => {
  it('returns undefined when the apiKey credential is absent', () => {
    expect(buildGeminiAuthOptions({})).toBeUndefined();
  });

  it('preserves blank apiKey values so initGemini can reject them explicitly', () => {
    expect(buildGeminiAuthOptions({ apiKey: '' })).toEqual({ apiKey: '' });
    expect(buildGeminiAuthOptions({ apiKey: '   ' })).toEqual({ apiKey: '   ' });
  });
});

describe('initGemini', () => {
  beforeEach(() => {
    geminiChatCtor.mockClear();
    getCoreSystemPromptMock.mockClear();
  });

  it('creates GeminiChat instance', async () => {
    const geminiConfig = makeGeminiConfig([{ name: 'read_file' }, { name: 'run_shell_command' }]);
    await initGemini(geminiConfig, ['run_shell_command']);

    expect(geminiChatCtor.mock.calls.length).toBe(1);
    expect(getCoreSystemPromptMock).toHaveBeenCalledTimes(1);
  });

  it('uses Gemini API auth when a non-empty apiKey is provided', async () => {
    const geminiConfig = makeGeminiConfig([{ name: 'read_file' }]);
    await initGemini(geminiConfig, [], undefined, { apiKey: '  test-key  ' });

    expect(geminiConfig.refreshAuth).toHaveBeenCalledWith('USE_GEMINI', 'test-key');
  });

  it('throws when authOptions is provided without a valid apiKey', async () => {
    const geminiConfig = makeGeminiConfig([{ name: 'read_file' }]);

    await expect(initGemini(geminiConfig, [], undefined, {})).rejects.toThrow(
      'Gemini authOptions were provided without a valid API key.',
    );
    expect(geminiConfig.refreshAuth).not.toHaveBeenCalled();
  });

  it('throws when an explicit apiKey is empty', async () => {
    const geminiConfig = makeGeminiConfig([{ name: 'read_file' }]);

    await expect(initGemini(geminiConfig, [], undefined, { apiKey: '' })).rejects.toThrow(
      'Gemini API key was provided but is empty or whitespace-only.',
    );
  });

  it('throws when an explicit apiKey is whitespace-only', async () => {
    const geminiConfig = makeGeminiConfig([{ name: 'read_file' }]);

    await expect(initGemini(geminiConfig, [], undefined, { apiKey: '   ' })).rejects.toThrow(
      'Gemini API key was provided but is empty or whitespace-only.',
    );
  });

  it('falls back to OAuth only when authOptions is omitted', async () => {
    const geminiConfig = makeGeminiConfig([{ name: 'read_file' }]);
    await initGemini(geminiConfig, []);

    expect(geminiConfig.refreshAuth).toHaveBeenCalledWith('LOGIN_WITH_GOOGLE');
  });
});
