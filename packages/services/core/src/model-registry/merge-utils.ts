import type { AIModelMetadata } from '@makaio/contracts';

/**
 * Clone model metadata and its nested mutable structures.
 * @param metadata - Metadata to clone.
 * @returns A structurally independent metadata descriptor.
 */
export function cloneModelMetadata(metadata: AIModelMetadata): AIModelMetadata {
  const cloned: AIModelMetadata = { ...metadata };

  if (metadata.capabilities !== undefined) {
    cloned.capabilities = cloneModelCapabilities(metadata.capabilities);
  }

  if (metadata.pricing !== undefined) {
    cloned.pricing = cloneModelPricing(metadata.pricing);
  }

  return cloned;
}

/**
 * Clone provider-scoped capability metadata.
 * @param capabilities - Capabilities to clone.
 * @returns A structurally independent capabilities descriptor.
 */
function cloneModelCapabilities(
  capabilities: NonNullable<AIModelMetadata['capabilities']>,
): NonNullable<AIModelMetadata['capabilities']> {
  const cloned: NonNullable<AIModelMetadata['capabilities']> = { ...capabilities };

  if (capabilities.speechToText !== undefined) {
    cloned.speechToText = {
      ...capabilities.speechToText,
      modes: [...capabilities.speechToText.modes],
    };
  }

  if (capabilities.textToSpeech !== undefined) {
    cloned.textToSpeech = {
      ...capabilities.textToSpeech,
      modes: [...capabilities.textToSpeech.modes],
    };
    if (capabilities.textToSpeech.outputFormats !== undefined) {
      cloned.textToSpeech.outputFormats = [...capabilities.textToSpeech.outputFormats];
    }
  }

  return cloned;
}

/**
 * Clone model pricing metadata.
 * @param pricing - Pricing metadata to clone.
 * @returns A structurally independent pricing descriptor.
 */
function cloneModelPricing(pricing: NonNullable<AIModelMetadata['pricing']>): NonNullable<AIModelMetadata['pricing']> {
  const cloned: NonNullable<AIModelMetadata['pricing']> = { ...pricing };

  if (pricing.token !== undefined) {
    cloned.token = { ...pricing.token };
  }

  if (pricing.request !== undefined) {
    cloned.request = { ...pricing.request };
  }

  return cloned;
}

/**
 * Merge model metadata with block-level replacement and defensive clone semantics.
 *
 * Top-level metadata fields merge field-by-field. When an overlay supplies
 * `capabilities` or `pricing`, that whole block replaces the base block.
 * Returned metadata is structurally independent from both inputs.
 * @param baseMetadata - Metadata supplied by the base model.
 * @param overlayMetadata - Metadata supplied by the overlay model.
 * @returns Merged metadata, or undefined when neither side supplies metadata.
 */
export function mergeModelMetadata(
  baseMetadata: AIModelMetadata | undefined,
  overlayMetadata: AIModelMetadata | undefined,
): AIModelMetadata | undefined {
  if (overlayMetadata === undefined) {
    return baseMetadata === undefined ? undefined : cloneModelMetadata(baseMetadata);
  }

  if (baseMetadata === undefined) {
    return cloneModelMetadata(overlayMetadata);
  }

  return cloneModelMetadata({
    ...baseMetadata,
    ...overlayMetadata,
    capabilities: overlayMetadata.capabilities ?? baseMetadata.capabilities,
    pricing: overlayMetadata.pricing ?? baseMetadata.pricing,
  });
}
