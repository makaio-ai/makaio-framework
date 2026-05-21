import { BusError } from './bus-error.js';

/**
 * Thrown when an operation is attempted on a closed DirectChannel.
 * All pending requests are rejected with this error when a channel closes.
 */
export class ChannelClosedError extends BusError {
  /**
   * @param channelId - The identifier of the channel that is closed
   */
  public constructor(channelId: string) {
    super(`Channel "${channelId}" is closed`, channelId);
    this.name = 'ChannelClosedError';
  }
}
