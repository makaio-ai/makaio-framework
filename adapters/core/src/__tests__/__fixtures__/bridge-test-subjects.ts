import { z } from 'zod';
import { MakaioBus } from '@makaio/bus-core';

/**
 * Test namespace for bridge/mapper tests that need global subjects.
 *
 * Registers fake global subjects under 'bridgeTest' namespace to enable
 * type-safe testing of bridge mappings without depending on real global subjects.
 *
 * Subjects are organized by domain:
 * - agent.*: AI agent events (thinking, deltas)
 * - orchestration.*: Flow control events (pause, resume, event)
 * - workspace.*: Workspace operations (getContext, query requests)
 */
const { subjects: BridgeTestSubjects } = MakaioBus.registerNamespace('bridgeTest', {
  // Agent domain subjects
  'agent.thinking': z.object({
    text: z.string(),
  }),

  'agent.delta': z.object({
    type: z.string(),
    content: z.string(),
  }),

  'agent.tool': z.object({
    text: z.string(),
  }),

  // Orchestration domain subjects
  // Note: Different payload shapes from local adapter subjects to test transformation logic
  'orchestration.pause': z.object({
    message: z.string(), // Different from local 'reason?: string'
  }),

  'orchestration.resume': z.object({
    resumeId: z.string(), // Different from local 'fromState?: string'
  }),

  'orchestration.event': z.object({
    name: z.string(), // Different from local 'eventType: string'
    payload: z.record(z.string(), z.unknown()).optional(), // Different from local 'data?: object'
  }),

  // Workspace domain requests
  // Note: Different payload shapes to test request/response transformation
  'workspace.getContext': {
    request: z.object({
      path: z.string(), // Different from local 'sessionId: string'
    }),
    response: z.object({
      fileContent: z.string(), // Different from local 'context: string'
    }),
  },

  'workspace.query': {
    request: z.object({
      searchTerm: z.string(), // Different from local 'query: string'
    }),
    response: z.object({
      items: z.array(z.record(z.string(), z.unknown())), // Different from local 'results: Array<object>'
    }),
  },
});

/**
 * Individual subject references for convenient importing.
 * @example
 * ```typescript
 * import { BridgeTestSubjects } from './bridge-test-subjects';
 *
 * mapper.proxyLocalToGlobal('thinking', BridgeTestSubjects.agentThinking, transform);
 * ```
 */
export const BridgeTestSubjects_Refs = {
  agentThinking: BridgeTestSubjects.agent.thinking,
  agentDelta: BridgeTestSubjects.agent.delta,
  agentTool: BridgeTestSubjects.agent.tool,
  orchestrationPause: BridgeTestSubjects.orchestration.pause,
  orchestrationResume: BridgeTestSubjects.orchestration.resume,
  orchestrationEvent: BridgeTestSubjects.orchestration.event,
  workspaceGetContext: BridgeTestSubjects.workspace.getContext,
  workspaceQuery: BridgeTestSubjects.workspace.query,
};

export { BridgeTestSubjects };
