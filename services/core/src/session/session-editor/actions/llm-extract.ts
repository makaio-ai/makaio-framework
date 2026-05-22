import type { IMakaioBus } from '@makaio/bus-core';
import type { SessionMessage } from '@makaio/contracts';
import { AdapterSubjects, AgentResolutionSubjects } from '@makaio/contracts';
import { AdapterRuntimeSubjects } from '@makaio/services-core/adapter-runtime';
import type { SessionEditorAction, ActionResult } from '../../../session-editor/types.js';
import { ExtractedContextSchema } from '../../../compression/schemas.js';
import { buildProviderContext } from '@makaio/services-core/provider-context';

/**
 * System prompt for context extraction.
 * Instructs the LLM to return structured JSON matching ExtractedContextSchema.
 * Any future changes to ExtractedContextSchema must be reflected here.
 */
export const EXTRACTION_SYSTEM_PROMPT = `You are a context extraction assistant. Analyze the following conversation and extract structured information. Respond with ONLY valid JSON matching this exact schema — no markdown, no explanation, no code fences:

{
  "resolved_items": ["string — completed work with resolution details"],
  "known_bugs": [{ "issue": "string", "location": "string", "impact": "string" }],
  "todos": [{ "issue": "string", "location": "string", "priority": "high|medium|low" }],
  "key_decisions_and_rationale": ["string — decision with reasoning"],
  "technical_details": {
    "files": ["string — file paths mentioned"],
    "schemas": {},
    "apis": ["string — API endpoints or contracts"],
    "config": {}
  },
  "constraints_and_requirements": ["string — constraints or non-negotiable requirements"],
  "current_state": "string — one paragraph summary of where work stands now",
  "roadmap": ["string — future work items in priority order"],
  "data_flows": ["string — key data movement patterns"],
  "component_interactions": { "ComponentName": "string — description of its role" },
  "key_files": { "filepath": "string — what this file does" },
  "helpful_hint": ["string — quick reference hints for resuming work"]
}

Rules:
- Omit array items you have no evidence for (prefer empty array over fabrication).
- current_state MUST be present; write "No summary available" if you cannot determine it.
- Extract only facts stated or clearly implied in the conversation. Do not invent.
- key_files and component_interactions should only include items explicitly mentioned.`;

/**
 * Serialize session messages into a compact conversation string for LLM extraction.
 *
 * Only user and assistant roles are included. Tool messages are skipped.
 * Within each message, only text blocks are included; reasoning, tool_call,
 * and tool_output blocks are omitted. Empty messages (after filtering) are
 * omitted entirely.
 * @param messages - Session messages to serialize
 * @returns Compact XML-like conversation string
 */
export function serializeMessagesForExtraction(messages: SessionMessage[]): string {
  const parts: string[] = [];

  for (const message of messages) {
    const textBlocks = message.blocks.filter(
      (block): block is Extract<(typeof message.blocks)[number], { type: 'text' }> => block.type === 'text',
    );
    const textContent = textBlocks.map((block) => block.content).join('\n');

    if (!textContent) continue;

    if (message.role === 'user') {
      parts.push(`[human]\n${textContent}\n[/human]`);
    } else if (message.role === 'assistant') {
      parts.push(`[assistant]\n${textContent}\n[/assistant]`);
    }
    // other roles (if any future additions) are skipped defensively
  }

  return `<conversation>\n${parts.join('\n\n')}\n</conversation>`;
}

/**
 * Creates the llm-extract pipeline action, closed over a bus instance.
 *
 * Extracts structured context from conversation messages using a cheap
 * LLM model resolved via AgentResolution. Returns `{ kind: 'context', json }`
 * on success (terminating the pipeline), or `{ kind: 'messages', messages }`
 * on any failure (allowing messages-to-context to run as fallback).
 *
 * Requires `options.virtualModelId` (string). Without it, the action is
 * a pure no-op with zero bus calls.
 * @param bus - Bus instance for VirtualModel resolution and adapter.infer calls
 * @returns SessionEditorAction registered as 'llm-extract'
 */
export function createLlmExtractAction(bus: IMakaioBus): SessionEditorAction {
  return {
    id: 'llm-extract',
    label: 'LLM Extract',
    description: 'Extract structured context using a cheap LLM model (requires virtualModelId in options)',
    category: 'extraction',

    /**
     * Execute LLM-based context extraction.
     *
     * All failure modes degrade gracefully — any error returns the input
     * messages unchanged so the pipeline can fall through to messages-to-context.
     * @param messages - Session messages to extract context from
     * @param options - Pipeline step options; must include `virtualModelId: string`
     * @returns Structured context on success, or pass-through messages on any failure
     */
    async execute(messages: SessionMessage[], options?: Record<string, unknown>): Promise<ActionResult> {
      const passThrough: ActionResult = { kind: 'messages', messages };

      const virtualModelId = options?.virtualModelId;
      if (typeof virtualModelId !== 'string') {
        return passThrough;
      }

      const sessionIdFromOptions =
        typeof options?.sessionId === 'string' && options.sessionId.length > 0 ? options.sessionId : undefined;
      const sessionId = sessionIdFromOptions ?? messages[0]?.sessionId;
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        return passThrough;
      }

      try {
        // Step 1: Resolve virtualModelId → adapterName + model via AgentResolution seam
        const resolvedTarget = await bus.request(AgentResolutionSubjects.resolve, {
          selection: { kind: 'virtual-model', virtualModelId },
          context: { sessionId },
        });

        // Step 2: Resolve adapterName → adapterId
        const { adapterId } = await bus.request(AdapterRuntimeSubjects.resolveId, {
          adapterName: resolvedTarget.adapterName,
        });

        // Step 3: Serialize conversation for the LLM prompt
        const prompt = serializeMessagesForExtraction(messages);

        // Step 4: Build provider context (credential refs), then run ephemeral inference
        const providerContext = resolvedTarget.providerConfigId
          ? await buildProviderContext(bus, resolvedTarget.providerConfigId)
          : undefined;

        const { text } = await bus.request(AdapterSubjects.infer, {
          adapterId,
          prompt,
          model: resolvedTarget.model,
          systemPrompt: EXTRACTION_SYSTEM_PROMPT,
          ...(providerContext !== undefined && { providerContext }),
        });

        // Step 5: Parse JSON and validate against ExtractedContextSchema
        const cleaned = text
          .trim()
          .replace(/^```(?:json)?\s*/i, '')
          .replace(/\s*```$/i, '')
          .trim();
        const parsed: unknown = JSON.parse(cleaned);
        const extractedContext = ExtractedContextSchema.parse(parsed);

        // Step 6: Estimate tokens (~4 chars per token)
        const tokenEstimate = Math.ceil(JSON.stringify(extractedContext).length / 4);

        return {
          kind: 'context',
          json: { ...extractedContext },
          tokenEstimate,
        };
      } catch (error) {
        console.warn('[llm-extract] action failed', { action: 'llm-extract', sessionId, error });
        return passThrough;
      }
    },
  };
}
