import type { ExtractSubjectPayload } from '@makaio/core';
import {
  AgentSubjects,
  AdapterSubjects,
  type BlockData,
  type SessionMessageBlock,
  type StepType,
} from '@makaio/contracts';
import type { AgentContext, ContextWindowInput, NormalizedCallUsage } from './types.js';
import type { MessageHandle } from '../message-handle/index.js';
import type { ToolCallTracker, ResolveHints } from './tool-call-tracker.js';

/**
 * Dependencies for AgentEventBridge.
 */
export interface AgentEventBridgeConfig {
  /** Emit usage payload (agent context gets added by AIAgent). */
  emitUsage: (payload: Omit<ExtractSubjectPayload<typeof AgentSubjects.usage>, keyof AgentContext>) => Promise<void>;
  /** Emit context window status payload. */
  emitContextWindowUpdated: (
    payload: Omit<ExtractSubjectPayload<typeof AgentSubjects.contextWindow.updated>, keyof AgentContext>,
  ) => Promise<void>;
  /** Emit tool.use payload. */
  emitToolUse: (
    payload: Omit<ExtractSubjectPayload<typeof AgentSubjects.tool.use>, keyof AgentContext>,
  ) => Promise<void>;
  /** Emit tool.output payload. */
  emitToolOutput: (
    payload: Omit<ExtractSubjectPayload<typeof AgentSubjects.tool.output>, keyof AgentContext>,
  ) => Promise<void>;
  /** Emit adapter log payload. */
  emitAdapterLog: (
    payload: Omit<ExtractSubjectPayload<typeof AdapterSubjects.log>, 'adapterId' | 'adapterName'>,
  ) => Promise<void>;
  /** Emit step.started payload. */
  emitStepStarted: (
    payload: Omit<ExtractSubjectPayload<typeof AgentSubjects.step.started>, keyof AgentContext>,
  ) => Promise<void>;
  /** Emit step.finished payload. */
  emitStepFinished: (
    payload: Omit<ExtractSubjectPayload<typeof AgentSubjects.step.finished>, keyof AgentContext>,
  ) => Promise<void>;
  /** Correlation tracker for tool.use -\> tool.output. */
  toolCallTracker: ToolCallTracker;
  /** Current content block index getter. */
  getBlockIndex: () => number;
  /** Increment block index after step completion. */
  incrementBlockIndex: () => void;
  /** Resolve model name for usage events. */
  getUsageModel: () => string | undefined;
  /** Get the message handle whose provider request is currently active. */
  getActiveMessageHandle: () => MessageHandle | undefined;
}

/**
 * Resolution metadata returned when emitting tool output.
 */
export interface ToolOutputResult {
  toolCallId: string;
  toolName: string;
  args?: Record<string, unknown>;
}

/**
 * Event-focused helper for AIAgent.
 *
 * Keeps event payload formatting, correlation warnings, and block-indexed
 * step emissions out of the base class while preserving existing behavior.
 */
export class AgentEventBridge {
  private readonly emitUsagePayload: AgentEventBridgeConfig['emitUsage'];
  private readonly emitContextWindowUpdatedPayload: AgentEventBridgeConfig['emitContextWindowUpdated'];
  private readonly emitToolUsePayload: AgentEventBridgeConfig['emitToolUse'];
  private readonly emitToolOutputPayload: AgentEventBridgeConfig['emitToolOutput'];
  private readonly emitAdapterLogPayload: AgentEventBridgeConfig['emitAdapterLog'];
  private readonly emitStepStartedPayload: AgentEventBridgeConfig['emitStepStarted'];
  private readonly emitStepFinishedPayload: AgentEventBridgeConfig['emitStepFinished'];
  private readonly toolCallTracker: ToolCallTracker;
  private readonly getBlockIndex: () => number;
  private readonly incrementBlockIndex: () => void;
  private readonly getUsageModel: () => string | undefined;
  private readonly getActiveMessageHandle: () => MessageHandle | undefined;

  /**
   * Create an event bridge with emission and correlation dependencies.
   * @param config - Event bridge dependencies (emitters, tracker, and block-index accessors)
   */
  public constructor(config: AgentEventBridgeConfig) {
    this.emitUsagePayload = config.emitUsage;
    this.emitContextWindowUpdatedPayload = config.emitContextWindowUpdated;
    this.emitToolUsePayload = config.emitToolUse;
    this.emitToolOutputPayload = config.emitToolOutput;
    this.emitAdapterLogPayload = config.emitAdapterLog;
    this.emitStepStartedPayload = config.emitStepStarted;
    this.emitStepFinishedPayload = config.emitStepFinished;
    this.toolCallTracker = config.toolCallTracker;
    this.getBlockIndex = config.getBlockIndex;
    this.incrementBlockIndex = config.incrementBlockIndex;
    this.getUsageModel = config.getUsageModel;
    this.getActiveMessageHandle = config.getActiveMessageHandle;
  }

  /**
   * Emit usage event to global bus.
   * @param normalized - Provider-normalized usage metrics
   */
  public async trackUsage(normalized: NormalizedCallUsage): Promise<void> {
    const requestCorrelation = this.getActiveMessageHandle()?.requestCorrelation;
    await this.emitUsagePayload({
      ...normalized,
      ...(normalized.executionId === undefined && requestCorrelation?.executionId !== undefined
        ? { executionId: requestCorrelation.executionId }
        : {}),
      ...(normalized.frameId === undefined && requestCorrelation?.frameId !== undefined
        ? { frameId: requestCorrelation.frameId }
        : {}),
      model: this.getUsageModel() ?? 'unknown',
    });
  }

  /**
   * Emit context window health signal.
   * @param input - Raw usage and capacity metrics
   */
  public async emitContextWindowUpdate(input: ContextWindowInput): Promise<void> {
    const { currentTokens, maxTokens, cachedTokens } = input;
    const hasValidCapacity = maxTokens > 0 && Number.isFinite(maxTokens) && Number.isFinite(currentTokens);
    const percentage = hasValidCapacity ? Math.min(100, (currentTokens / maxTokens) * 100) : 0;
    const level = hasValidCapacity ? (percentage >= 80 ? 'critical' : percentage >= 60 ? 'warn' : 'ok') : 'critical';

    await this.emitContextWindowUpdatedPayload({
      currentTokens,
      maxTokens,
      cachedTokens,
      percentage,
      level,
    });
  }

  /**
   * Emit tool.use event with correlation tracking.
   * @param toolName - Tool identifier
   * @param args - Tool arguments
   * @param nativeId - Provider-native call ID
   * @returns Correlation ID for the call
   */
  public async emitToolUse(toolName: string, args?: Record<string, unknown>, nativeId?: string): Promise<string> {
    const toolCallId = this.toolCallTracker.register(toolName, args, nativeId);
    await this.emitToolUsePayload({
      toolName,
      args,
      toolCallId,
    });
    return toolCallId;
  }

  /**
   * Emit tool.output event with best-effort correlation resolution.
   * @param output - Tool output text
   * @param hints - Correlation hints from adapter events
   * @returns Resolved toolCallId, toolName (falls back to 'unknown'), and args from the matched tool.use call
   */
  public async emitToolOutput(output: string, hints: ResolveHints): Promise<ToolOutputResult> {
    const { correlationId, strategy, toolName, args } = this.toolCallTracker.resolve(hints);
    if (!correlationId) {
      await this.emitAdapterLogPayload({
        level: 'warn',
        message: `Tool output arrived with no pending tool calls. Hints: ${JSON.stringify(hints)}`,
        timestamp: Date.now(),
      });
      const fallbackId = crypto.randomUUID();
      await this.emitToolOutputPayload({ output, toolCallId: fallbackId, toolName: hints.toolName ?? toolName });
      return { toolCallId: fallbackId, toolName: hints.toolName ?? toolName ?? 'unknown' };
    }

    if (strategy === 'oldest') {
      await this.emitAdapterLogPayload({
        level: 'warn',
        message: `Tool output correlation used fallback. Hints: ${JSON.stringify(hints)}`,
        timestamp: Date.now(),
      });
    }

    await this.emitToolOutputPayload({ output, toolCallId: correlationId, toolName, args });
    return { toolCallId: correlationId, toolName: toolName ?? 'unknown', args };
  }

  /**
   * Emit step.started for the current block index.
   * @param stepType - Block step type
   * @param blockData - Optional step metadata
   * @param content - Optional immediate block content
   */
  public async emitStepStarted(
    stepType: StepType,
    blockData?: BlockData,
    content?: SessionMessageBlock,
  ): Promise<void> {
    await this.emitStepStartedPayload({
      stepType,
      blockIndex: this.getBlockIndex(),
      blockData,
      content,
    });
  }

  /**
   * Emit step.finished and advance block index.
   * @param stepType - Completed step type
   * @param content - Final block content
   */
  public async emitStepFinished(stepType: StepType, content: SessionMessageBlock): Promise<void> {
    await this.emitStepFinishedPayload({
      stepType,
      blockIndex: this.getBlockIndex(),
      content,
    });
    this.incrementBlockIndex();
  }
}
