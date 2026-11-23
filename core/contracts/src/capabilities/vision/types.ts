import type { CallContext } from '@makaio/core';
import type { ICapabilityProvider } from '../../capability/types.js';
import type { VisionAnalysisRequest, VisionAnalysisResult } from './schemas.js';

/**
 * Vision provider interface.
 *
 * Providers enable image analysis for non-vision LLMs.
 */
export interface IVisionProvider extends ICapabilityProvider {
  /**
   * Analyze an image and return a description.
   * @param call - Call of the handled analysis request
   * @param request - Analysis request with image and optional prompt
   */
  analyze(call: CallContext, request: VisionAnalysisRequest): Promise<VisionAnalysisResult>;

  /**
   * Check if the provider is available (e.g. underlying adapter is ready).
   */
  isAvailable(): Promise<boolean>;
}
