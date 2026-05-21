import { BusError } from './bus-error.js';

/**
 * Thrown when a channel-only subject is used directly on the public bus.
 * Channel subjects must be routed through a DirectChannel, not the public bus API.
 */
export class ChannelOnlyError extends BusError {
  /**
   * @param subject - The channel-only subject that was used on the public bus
   */
  public constructor(subject: string) {
    super(
      `Subject "${subject}" is channel-only and cannot be used on the public bus. Use a DirectChannel instead.`,
      subject,
    );
    this.name = 'ChannelOnlyError';
  }
}
