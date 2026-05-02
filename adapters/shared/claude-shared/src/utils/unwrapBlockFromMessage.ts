import { z } from 'zod';

/**
 * Unwraps an SDK block from a message, widening it to the inferred schema type.
 *
 * The generic constraint `SDKBlock extends z.infer<Schema>` guarantees that the
 * concrete SDK block type is structurally assignable to the schema's output type,
 * so the return is a safe widening with no cast required.
 * @param sdkBlock - The SDK block to unwrap
 * @param _schema - The Zod schema used to infer the return type (not called at runtime)
 * @returns The unwrapped block widened to the inferred schema type
 */
export function unwrapBlockFromMessage<Schema extends z.ZodType<{ type: string }>, SDKBlock extends z.infer<Schema>>(
  sdkBlock: SDKBlock,
  _schema: Schema,
): z.infer<Schema> {
  return sdkBlock;
}
