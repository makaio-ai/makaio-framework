import type { SessionMessage } from '@makaio/contracts';
import type { SessionEditorAction } from '../../../session-editor/types.js';

/**
 * Summarizes messages using LLM inference.
 *
 * This action is used by the fork modal's "Summarize" segment policy
 * to generate a condensed summary of a conversation segment.
 * The summary replaces the original messages, reducing context window usage.
 *
 * Note: This action requires an adapter to be available for inference.
 * The actual LLM call is made by the fork modal UI via adapter.infer —
 * this action exists in the registry for discoverability and pipeline
 * composition, but its execute() is a no-op since summarization is eager
 * (preview-based) rather than lazy (pipeline-based).
 */
export const llmSummarizeAction: SessionEditorAction = {
  id: 'llm-summarize',
  label: 'Summarize',
  description: 'LLM-generated summary of selected messages',
  category: 'transformation',

  /**
   * Eager summarization has already happened in the UI before pipeline execution.
   * @param messages - Messages that would be summarized in a lazy pipeline model
   * @returns Unchanged messages (pipeline no-op)
   */
  async execute(messages: SessionMessage[]) {
    // Summarization is eager (runs before fork creation via adapter.infer in the UI).
    // In pipelines this action intentionally passes through without modifying messages.
    return { kind: 'messages' as const, messages };
  },
};
