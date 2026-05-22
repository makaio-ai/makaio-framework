import type { IMakaioBus } from '@makaio/bus-core';
import { NoHandlerError } from '@makaio/bus-core';
// IMPORTANT: Use shared Message type (has .blocks), NOT agent/schemas/message.ts (has .content)
import type { Message, SessionMessage } from '@makaio/contracts';
import { MessageStorageSubjects } from './messages/index.js';

/**
 * Enriches messageHistory with turn-so-far messages for immediate delivery.
 *
 * Uses MessageStorageSubjects to load messages already persisted in the current turn.
 * For immediate messages within an active turn, this provides context from:
 * - The initiating user message
 * - Any assistant responses from agents that have already completed
 */
export class TurnContextEnricher {
  public constructor(private readonly bus: IMakaioBus) {}

  /**
   * Load turn-so-far messages and convert to Message[].
   * @param turnId - Turn ID to load context for
   * @returns Messages representing turn-so-far context
   */
  public async getTurnSoFarContext(turnId: string): Promise<Message[]> {
    try {
      const { messages } = await this.bus.request(MessageStorageSubjects.getByTurn, {
        turnId,
      });

      return this.convertSessionMessagesToMessages(messages);
    } catch (error) {
      // If no handler registered (e.g., during tests), return empty context
      if (error instanceof NoHandlerError) {
        return [];
      }
      console.warn('[TurnContextEnricher] Failed to load turn-so-far context:', error);
      return [];
    }
  }

  /**
   * Enrich messageHistory for immediate delivery mode.
   * @param originalHistory - Curated history from sessionContext
   * @param turnId - Turn ID for current turn
   * @param deliveryMode - Message delivery mode
   * @returns Enriched messageHistory (original + turn-so-far for immediate)
   */
  public async enrichForDeliveryMode(
    originalHistory: Message[] | undefined,
    turnId: string,
    deliveryMode: 'enqueue' | 'immediate' | 'replace' | undefined,
  ): Promise<Message[] | undefined> {
    // Only enrich for immediate messages
    if (deliveryMode !== 'immediate') {
      return originalHistory;
    }

    const turnSoFar = await this.getTurnSoFarContext(turnId);

    if (turnSoFar.length === 0) {
      return originalHistory;
    }

    return [...(originalHistory ?? []), ...turnSoFar];
  }

  /**
   * Convert SessionMessage[] to shared Message[] format.
   *
   * Since SessionMessageBlock and MessageBlock are unified, blocks pass through directly.
   * @param sessionMessages - Messages from storage
   * @returns Array of Message objects
   */
  private convertSessionMessagesToMessages(sessionMessages: SessionMessage[]): Message[] {
    return sessionMessages.map((msg) => ({
      role: msg.role,
      blocks: msg.blocks,
    }));
  }
}
