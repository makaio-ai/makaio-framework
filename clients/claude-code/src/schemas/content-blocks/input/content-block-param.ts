import { z } from 'zod';
import { BetaTextBlockParamSchema } from './text-block-param.js';
import { BetaImageBlockParamSchema } from './image-block-param.js';
import { BetaDocumentBlockParamSchema } from './document-block-param.js';
import { BetaSearchResultBlockParamSchema } from './search-result-block-param.js';
import { BetaThinkingBlockParamSchema } from './thinking-block-param.js';
import { BetaRedactedThinkingBlockParamSchema } from './redacted-thinking-block-param.js';
import { BetaToolUseBlockParamSchema } from './tool-use-block-param.js';
import { BetaToolResultBlockParamSchema } from './tool-result-block-param.js';
import { BetaServerToolUseBlockParamSchema } from './server-tool-use-block-param.js';
import { BetaWebSearchToolResultBlockParamSchema } from './web-search-tool-result-block-param.js';
import { BetaCodeExecutionToolResultBlockParamSchema } from './code-execution-tool-result-block-param.js';
import { BetaMCPToolUseBlockParamSchema } from './mcp-tool-use-block-param.js';
import { BetaMCPToolResultBlockParamSchema } from './mcp-tool-result-block-param.js';
import { BetaContainerUploadBlockParamSchema } from './container-upload-block-param.js';

/**
 * Union of all input content block parameter types
 * @see BetaContentBlockParam from \@anthropic-ai/sdk
 */
export const BetaContentBlockParamSchema = z.discriminatedUnion('type', [
  BetaTextBlockParamSchema,
  BetaImageBlockParamSchema,
  BetaDocumentBlockParamSchema,
  BetaSearchResultBlockParamSchema,
  BetaThinkingBlockParamSchema,
  BetaRedactedThinkingBlockParamSchema,
  BetaToolUseBlockParamSchema,
  BetaToolResultBlockParamSchema,
  BetaServerToolUseBlockParamSchema,
  BetaWebSearchToolResultBlockParamSchema,
  BetaCodeExecutionToolResultBlockParamSchema,
  BetaMCPToolUseBlockParamSchema,
  BetaMCPToolResultBlockParamSchema,
  BetaContainerUploadBlockParamSchema,
]);

export type BetaContentBlockParam = z.infer<typeof BetaContentBlockParamSchema>;
