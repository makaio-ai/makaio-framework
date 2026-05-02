import {
  UI_WARNINGS_CATEGORY,
  CONNECTOR_SWAP_WARNING_SUPPRESSED_KEY,
  INTERACTIVE_DIALOG_TIMEOUT_MS,
  CONNECTOR_SWAP_WARNING_OPTION_IDS,
} from '@makaio/contracts';
import type { PipelineStep } from '../session-editor/types.js';

export {
  UI_WARNINGS_CATEGORY,
  CONNECTOR_SWAP_WARNING_SUPPRESSED_KEY,
  INTERACTIVE_DIALOG_TIMEOUT_MS,
  CONNECTOR_SWAP_WARNING_OPTION_IDS,
};

/** Default transform pipeline for connector-swap history injection. */
export const CONNECTOR_SWAP_DEFAULT_PIPELINE: PipelineStep[] = [
  { actionId: 'strip-reasoning' },
  { actionId: 'strip-tool-outputs' },
];
