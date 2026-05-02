import { describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, AgentResolutionSubjects } from '@makaio/contracts';
import { AdapterRuntimeSubjects } from '@makaio/services-core/adapter-runtime';
import type { SessionMessage } from '@makaio/contracts';
import { createLlmExtractAction } from '../llm-extract.js';

describe('createLlmExtractAction sessionId handling', () => {
  it('falls back to first message sessionId when options.sessionId is empty', async () => {
    MakaioBus.__resetHandlers?.();
    const unsubs: Array<() => void> = [];
    try {
      unsubs.push(
        MakaioBus.on(AgentResolutionSubjects.resolve, (ctx) => {
          ctx.setResult({ adapterName: 'claude-code', model: 'haiku', contextMode: 'fresh', compressionMode: 'off' });
        }),
      );
      unsubs.push(
        MakaioBus.on(AdapterRuntimeSubjects.resolveId, (ctx) => {
          ctx.setResult({ adapterId: 'adapter-1' });
        }),
      );
      unsubs.push(
        MakaioBus.on(AdapterSubjects.infer, (ctx) => {
          ctx.setResult({
            text: JSON.stringify({
              resolved_items: [],
              known_bugs: [],
              todos: [],
              key_decisions_and_rationale: [],
              technical_details: { files: [], schemas: {}, apis: [], config: {} },
              constraints_and_requirements: [],
              current_state: 'ok',
              roadmap: [],
              data_flows: [],
              component_interactions: {},
              key_files: {},
              helpful_hint: [],
            }),
          });
        }),
      );

      const action = createLlmExtractAction(MakaioBus);
      const messages: SessionMessage[] = [
        {
          messageId: 'm1',
          turnId: null,
          sessionId: 'session-from-message',
          role: 'user',
          contentText: 'hello',
          blocks: [{ type: 'text', content: 'hello' }],
          timestamp: 1,
        },
      ];

      const result = await action.execute(messages, { virtualModelId: 'cheap-extraction', sessionId: '' });
      expect(result.kind).toBe('context');
    } finally {
      unsubs.forEach((unsub) => unsub());
    }
  });
});
