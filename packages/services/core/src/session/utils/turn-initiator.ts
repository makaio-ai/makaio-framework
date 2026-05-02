import type { TurnInitiator } from '@makaio/contracts';

/**
 * Builds turn initiator metadata from `sendMessage` source fields.
 *
 * Returns `{ source: 'extension', sourceId: extensionId }` for extension-initiated turns,
 * `{ source }` for other explicit sources, or `{ source: 'user' }` as the default.
 * @param source - Optional turn origin discriminator
 * @param extensionId - Required when `source === 'extension'`
 * @returns Normalised turn initiator
 * @throws Error when `source` is `'extension'` and `extensionId` is absent or blank
 */
export function buildTurnInitiator(
  source: 'extension' | 'user' | 'system' | undefined,
  extensionId: string | undefined,
): TurnInitiator {
  if (source === 'extension') {
    const normalizedExtensionId = extensionId?.trim();
    if (!normalizedExtensionId) {
      throw new Error('extensionId is required when source is "extension"');
    }
    return { source: 'extension', sourceId: normalizedExtensionId };
  }

  if (source) {
    return { source };
  }

  return { source: 'user' };
}
