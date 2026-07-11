import { describe, expect, it } from 'vitest';
import { clientDefinition as claudeCodeDefinition } from '../claude-code/src/definition.js';
import { clientDefinition as codexDefinition } from '../codex/src/definition.js';
import { clientDefinition as cursorDefinition } from '../cursor/src/definition.js';
import { clientDefinition as geminiDefinition } from '../gemini/src/definition.js';
import { clientDefinition as githubCopilotDefinition } from '../github-copilot/src/definition.js';
import { clientDefinition as qwenDefinition } from '../qwen/src/definition.js';

describe('first-party client auth declarations', () => {
  it('declares Claude native and OAuth-token authentication', () => {
    expect(claudeCodeDefinition.authMethods).toEqual([
      { id: 'native', mode: 'inferred', label: 'Native account' },
      {
        id: 'oauth-token',
        mode: 'explicit',
        label: 'OAuth token',
        fields: [
          {
            id: 'oauthToken',
            label: 'OAuth token',
            required: true,
            secret: true,
            sourceHints: [{ kind: 'environment', variable: 'CLAUDE_CODE_OAUTH_TOKEN' }],
          },
        ],
      },
    ]);
    expect(claudeCodeDefinition.defaultAuth).toEqual({
      providerDefinitionId: 'anthropic-oauth',
      methodId: 'native',
    });
  });

  it('declares Codex native and access-token authentication', () => {
    expect(codexDefinition.authMethods).toEqual([
      { id: 'native', mode: 'inferred', label: 'Native account' },
      {
        id: 'access-token',
        mode: 'explicit',
        label: 'Access token',
        fields: [
          {
            id: 'accessToken',
            label: 'Access token',
            required: true,
            secret: true,
            sourceHints: [{ kind: 'environment', variable: 'CODEX_ACCESS_TOKEN' }],
          },
        ],
      },
    ]);
    expect(codexDefinition.defaultAuth).toEqual({
      providerDefinitionId: 'openai-codex',
      methodId: 'native',
    });
  });

  it.each([
    cursorDefinition,
    geminiDefinition,
    githubCopilotDefinition,
    qwenDefinition,
  ])('$id explicitly declares no client-owned auth methods', (definition) => {
    expect(definition.authMethods).toEqual([]);
    expect(definition.defaultAuth).toBeUndefined();
  });
});
