import { z } from 'zod';

/**
 * Compression mode for session context management.
 * - `auto`: Plugin auto-compresses when context window is critical
 * - `manual`: User/plugin must explicitly request compression
 * - `off`: No compression (default for most profiles)
 */
export const CompressionModeSchema = z.enum(['auto', 'manual', 'off']);
export type CompressionMode = z.infer<typeof CompressionModeSchema>;
