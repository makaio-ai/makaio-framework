import type { AIModelMetadata, DiscoveredAIModel, ProviderDefinition, ReasoningLevelMap } from '@makaio/contracts';
import { CopilotClient, type ModelInfo } from '@github/copilot-sdk';

type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

// ─── Extended runtime types ──────────────────────────────────────────────────
// The SDK's TypeScript declarations are incomplete — the actual API response
// includes fields not yet in ModelInfo / ModelCapabilities / ModelBilling.
// We extend locally to capture what the API really returns.

/** Superset of the SDK's `ModelCapabilities.supports` with fields present at runtime. */
interface RuntimeSupports {
  vision: boolean;
  reasoningEffort: boolean;
  tool_calls?: boolean;
  parallel_tool_calls?: boolean;
  structured_outputs?: boolean;
  max_thinking_budget?: number;
  min_thinking_budget?: number;
}

/** Superset of the SDK's `ModelCapabilities.limits` with fields present at runtime. */
interface RuntimeLimits {
  max_context_window_tokens: number;
  max_prompt_tokens?: number;
  max_output_tokens?: number;
  vision?: {
    supported_media_types: string[];
    max_prompt_images: number;
    max_prompt_image_size: number;
  };
}

/** Superset of the SDK's `ModelBilling` with fields present at runtime. */
interface RuntimeBilling {
  multiplier: number;
  is_premium?: boolean;
}

// ─── Reasoning ───────────────────────────────────────────────────────────────

/**
 * Map Copilot SDK reasoning effort labels to our standardized reasoning levels.
 *
 * The Copilot SDK uses a subset of OpenAI-style effort strings.
 * We map 'xhigh' → 'extra-high' to match the canonical {@link AIReasoningLevel}.
 */
const EFFORT_TO_LEVEL: Record<ReasoningEffort, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'extra-high',
};

/**
 * Build a {@link ReasoningLevelMap} from Copilot SDK model info.
 * @param model - Copilot ModelInfo with optional reasoning effort data
 * @returns ReasoningLevelMap or undefined if reasoning is not supported
 */
function buildReasoningLevels(model: ModelInfo): ReasoningLevelMap | undefined {
  if (!model.supportedReasoningEfforts?.length) {
    return undefined;
  }

  const map: ReasoningLevelMap = {};
  for (const effort of model.supportedReasoningEfforts) {
    const level = EFFORT_TO_LEVEL[effort];
    if (level) {
      (map as Record<string, string>)[level] = effort;
    }
  }

  return Object.keys(map).length > 0 ? map : undefined;
}

// ─── Metadata ────────────────────────────────────────────────────────────────

/**
 * Build {@link AIModelMetadata} from Copilot SDK model info.
 *
 * Maps billing, capabilities, and output token limits into the canonical
 * metadata shape. Returns undefined when the model has no enrichable data.
 * @param model - Copilot ModelInfo (with runtime-extended fields)
 * @returns AIModelMetadata or undefined
 */
function buildMetadata(model: ModelInfo): AIModelMetadata | undefined {
  const supports = model.capabilities.supports as RuntimeSupports;
  const limits = model.capabilities.limits as RuntimeLimits;
  const billing = model.billing as RuntimeBilling | undefined;

  const metadata: AIModelMetadata = {};
  let hasData = false;

  // Output token limit
  if (limits.max_output_tokens !== undefined) {
    metadata.maxOutputTokens = limits.max_output_tokens;
    hasData = true;
  }

  // Capabilities
  const capabilities = {
    ...(supports.vision && { vision: true as const }),
    ...(supports.tool_calls && { toolCalling: true as const }),
    ...(supports.parallel_tool_calls && { parallelToolCalls: true as const }),
    ...(supports.structured_outputs && { structuredOutput: true as const }),
  };

  if (Object.keys(capabilities).length > 0) {
    metadata.capabilities = capabilities;
    hasData = true;
  }

  // Billing → pricing.request + includedInSubscription
  if (billing) {
    metadata.pricing = { request: { multiplier: billing.multiplier } };
    metadata.includedInSubscription = billing.is_premium === false;
    hasData = true;
  }

  return hasData ? metadata : undefined;
}

// ─── Normalization ───────────────────────────────────────────────────────────

/**
 * Normalize a Copilot SDK {@link ModelInfo} into the canonical {@link AIModel} shape.
 * @param model - Raw model info from the Copilot SDK
 * @returns Normalized AIModel
 */
function normalizeModel(model: ModelInfo): DiscoveredAIModel {
  const result: DiscoveredAIModel = {
    name: model.id,
    friendlyName: model.name,
    contextWindowSize: model.capabilities.limits.max_context_window_tokens,
    // labId omitted — Copilot aggregates models from multiple labs; resolved from curated data during registry merge
  };

  const reasoningLevels = buildReasoningLevels(model);
  if (reasoningLevels) {
    result.supportedReasoningLevels = reasoningLevels;
  }

  const metadata = buildMetadata(model);
  if (metadata) {
    result.metadata = metadata;
  }

  return result;
}

// ─── Fetcher ─────────────────────────────────────────────────────────────────

/**
 * Fetch live model list from GitHub Copilot via the Copilot SDK.
 *
 * Used only by the registry generation script — not imported at runtime.
 * Requires GitHub authentication (gh CLI auth or GITHUB_TOKEN env var).
 * The SDK handles credential resolution internally.
 * @param _definition - Provider definition (unused — Copilot auth is handled by the SDK)
 * @returns Array of normalized AIModel objects, or null if listing fails
 */
export async function fetchModels(_definition: ProviderDefinition): Promise<DiscoveredAIModel[] | null> {
  const client = new CopilotClient({
    cliArgs: ['--disable-builtin-mcps'],
  });

  try {
    await client.start();
    const models = await client.listModels();

    // Filter out disabled models
    const available = models.filter((m) => !m.policy || m.policy.state !== 'disabled');

    return available.map(normalizeModel);
  } finally {
    await client.stop();
  }
}
