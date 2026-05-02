import { z } from 'zod';

// Re-export all individual block schemas
export { BetaTextBlockSchema } from './text-block.js';
export type { BetaTextBlock } from './text-block.js';
export { BetaThinkingBlockSchema } from './thinking-block.js';
export type { BetaThinkingBlock } from './thinking-block.js';
export { BetaRedactedThinkingBlockSchema } from './redacted-thinking-block.js';
export type { BetaRedactedThinkingBlock } from './redacted-thinking-block.js';
export { BetaToolUseBlockSchema } from './tool-use-block.js';
export type { BetaToolUseBlock } from './tool-use-block.js';
export { BetaServerToolUseBlockSchema } from './server-tool-use-block.js';
export type { BetaServerToolUseBlock } from './server-tool-use-block.js';
export {
  BetaWebSearchResultBlockSchema,
  BetaWebSearchToolResultBlockContentSchema,
  BetaWebSearchToolResultBlockSchema,
  BetaWebSearchToolResultErrorCodeSchema,
  BetaWebSearchToolResultErrorSchema,
} from './web-search-tool-result-block.js';
export type {
  BetaWebSearchResultBlock,
  BetaWebSearchToolResultBlock,
  BetaWebSearchToolResultBlockContent,
  BetaWebSearchToolResultError,
  BetaWebSearchToolResultErrorCode,
} from './web-search-tool-result-block.js';
export {
  BetaCodeExecutionOutputBlockSchema,
  BetaCodeExecutionResultBlockSchema,
  BetaCodeExecutionToolResultBlockContentSchema,
  BetaCodeExecutionToolResultBlockSchema,
  BetaCodeExecutionToolResultErrorSchema,
} from './code-execution-tool-result-block.js';
export type {
  BetaCodeExecutionOutputBlock,
  BetaCodeExecutionResultBlock,
  BetaCodeExecutionToolResultBlock,
  BetaCodeExecutionToolResultBlockContent,
  BetaCodeExecutionToolResultError,
} from './code-execution-tool-result-block.js';
export { BetaMCPToolUseBlockSchema } from './mcp-tool-use-block.js';
export type { BetaMCPToolUseBlock } from './mcp-tool-use-block.js';
export { BetaMCPToolResultBlockSchema } from './mcp-tool-result-block.js';
export type { BetaMCPToolResultBlock } from './mcp-tool-result-block.js';
export { BetaContainerUploadBlockSchema } from './container-upload-block.js';
export type { BetaContainerUploadBlock } from './container-upload-block.js';

// Import for discriminated union
import { BetaTextBlockSchema } from './text-block.js';
import { BetaThinkingBlockSchema } from './thinking-block.js';
import { BetaRedactedThinkingBlockSchema } from './redacted-thinking-block.js';
import { BetaToolUseBlockSchema } from './tool-use-block.js';
import { BetaServerToolUseBlockSchema } from './server-tool-use-block.js';
import { BetaWebSearchToolResultBlockSchema } from './web-search-tool-result-block.js';
import { BetaCodeExecutionToolResultBlockSchema } from './code-execution-tool-result-block.js';
import { BetaMCPToolUseBlockSchema } from './mcp-tool-use-block.js';
import { BetaMCPToolResultBlockSchema } from './mcp-tool-result-block.js';
import { BetaContainerUploadBlockSchema } from './container-upload-block.js';

/**
 * Discriminated union of all Beta output content block types
 * @see BetaContentBlock from \@anthropic-ai/sdk
 */
export const BetaContentBlockSchema = z.discriminatedUnion('type', [
  BetaTextBlockSchema,
  BetaThinkingBlockSchema,
  BetaRedactedThinkingBlockSchema,
  BetaToolUseBlockSchema,
  BetaServerToolUseBlockSchema,
  BetaWebSearchToolResultBlockSchema,
  BetaCodeExecutionToolResultBlockSchema,
  BetaMCPToolUseBlockSchema,
  BetaMCPToolResultBlockSchema,
  BetaContainerUploadBlockSchema,
]);

export type BetaContentBlock = z.infer<typeof BetaContentBlockSchema>;
