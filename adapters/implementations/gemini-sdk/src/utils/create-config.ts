import { existsSync } from 'node:fs';
import os from 'node:os';
import { ApprovalMode, Config, PolicyDecision } from '@google/gemini-cli-core';
import type { GeminiSdkProviderSettings } from '../schemas.js';
import type { AIReasoningLevel } from '@makaio/ai-adapters-core';

/**
 * Maps normalized reasoning levels to Gemini thinkingBudget tokens (for 2.5-family models).
 * Values calibrated to balance reasoning quality vs latency/cost.
 */
const reasoningLevelToThinkingBudget: Record<AIReasoningLevel, number> = {
  none: 0,
  low: 512,
  medium: 2048,
  high: 8192,
  'extra-high': 16384,
};

/**
 * Maps normalized reasoning levels to Gemini ThinkingLevel values (for 3.x-family models).
 * Uses string literals instead of the ThinkingLevel enum to avoid version conflicts
 * between {@link https://www.npmjs.com/package/@google/genai | @google/genai} copies
 * (gemini-cli-core pins an older exact version).
 *
 * `'none'` maps to `'NONE'` to explicitly disable reasoning on 3.x models.
 */
const reasoningLevelToThinkingLevel: Record<AIReasoningLevel, string> = {
  none: 'NONE',
  low: 'LOW',
  medium: 'MEDIUM',
  high: 'HIGH',
  'extra-high': 'HIGH',
};

/** Input config for createGeminiConfig - minimal subset needed from connector config. */
interface CreateGeminiConfigInput {
  model?: string;
  cwd?: string;
  reasoningEffort?: AIReasoningLevel;
  providerConfig?: GeminiSdkProviderSettings;
  sessionId?: string;
}

/**
 * Create the SDK configuration before the connector applies the Adapter
 * Core-resolved API key through {@link Config.refreshAuth}.
 * @param connectorConfig - Connector configuration with model, cwd, and provider options
 * @returns Configured Config instance
 */
export function createGeminiConfig(connectorConfig: CreateGeminiConfigInput): Config {
  const cwd = connectorConfig.cwd ?? os.tmpdir();
  const model = connectorConfig.model ?? 'gemini-2.5-flash';
  const providerConfig = connectorConfig.providerConfig;
  const sessionId = connectorConfig.sessionId;

  // Validate working directory
  if (!existsSync(cwd)) {
    throw new Error(`Directory does not exist: ${cwd}`);
  }

  // Create Config for Makaio integration:
  // - interactive: false - no terminal prompts
  // - folderTrust/trustedFolder: false - require tool approvals
  // - policyEngineConfig.nonInteractive: false - PolicyEngine uses MessageBus for approvals
  const config = new Config({
    sessionId: sessionId ?? crypto.randomUUID(),
    targetDir: cwd,
    cwd,
    model,
    debugMode: providerConfig?.debugMode ?? false,
    interactive: false,
    checkpointing: providerConfig?.checkpointing ?? false,
    folderTrust: false,
    trustedFolder: false,
    approvalMode: ApprovalMode.DEFAULT,
    includeDirectories: ['/'],
    policyEngineConfig: {
      defaultDecision: PolicyDecision.ASK_USER,
      nonInteractive: false, // PolicyEngine publishes to MessageBus
    },
    telemetry: {
      enabled: false,
    },
  });

  // Skip the override for 'none' — the model uses its defaults (no thinking) without an explicit
  // override. Registering a thinking-config override for 'none' at construction time would
  // unnecessarily constrain models that do not support the thinkingLevel/thinkingBudget field.
  if (connectorConfig.reasoningEffort && connectorConfig.reasoningEffort !== 'none') {
    applyReasoningOverride(config, model, connectorConfig.reasoningEffort);
  }

  return config;
}

/**
 * Register a thinking-config runtime override that matches the SDK's default shape for the model.
 * The SDK uses `thinkingLevel` for some model families and `thinkingBudget` for others.
 * We inspect the resolved defaults and override the same field, avoiding conflicts.
 * @param config - The Gemini Config instance
 * @param model - The model identifier to register the override for
 * @param reasoningLevel - The normalized reasoning level to apply
 */
export function applyReasoningOverride(config: Config, model: string, reasoningLevel: AIReasoningLevel): void {
  const resolved = config.modelConfigService.getResolvedConfig({ model });
  const defaultThinking = resolved.generateContentConfig?.thinkingConfig;

  // Follow the SDK's lead: if defaults use thinkingLevel, override with thinkingLevel;
  // otherwise fall back to thinkingBudget (the 2.5-family default).
  const thinkingConfig =
    defaultThinking?.thinkingLevel !== undefined
      ? { thinkingLevel: reasoningLevelToThinkingLevel[reasoningLevel] }
      : { thinkingBudget: reasoningLevelToThinkingBudget[reasoningLevel] };

  // Cast needed: gemini-cli-core pins an older @google/genai (exact version), so its
  // ThinkingConfig/ThinkingLevel types are distinct TS symbols despite identical shapes.
  config.modelConfigService.registerRuntimeModelOverride({
    match: { model },
    modelConfig: {
      generateContentConfig: { thinkingConfig } as Record<string, unknown>,
    },
  });
}
