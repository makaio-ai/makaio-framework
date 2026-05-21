import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';

/**
 * Schema for the system.channel.open handshake request.
 *
 * This is the only public-bus subject the channel system introduces.
 * The handshake includes a capability token that acts as a bearer
 * credential. Public keys are not secret, but the token grants channel
 * access and should only travel over trusted transports. Callers should
 * prefer `transports: []` for same-process channels.
 */
export const SystemChannelSchemas = {
  'channel.open': {
    request: z.object({
      /** Name of the endpoint to connect to (e.g., 'credentials'). */
      endpoint: z.string(),
      /** Capability token for authentication. */
      token: z.string(),
      /** Base64-encoded ECDH P-256 public key from the client. */
      clientPubKey: z.string(),
      /**
       * Transport allowlist requested by the client.
       * Always sent by the client; an empty array means local-only (same-process only).
       */
      transports: z.array(z.string()),
    }),
    response: z.object({
      /** Unique channel identifier for this connection. */
      channelId: z.string(),
      /** Base64-encoded ECDH P-256 public key from the endpoint. */
      endpointPubKey: z.string(),
    }),
  },
} satisfies SchemaRecord;

/** Inferred request payload for the `system.channel.open` handshake. */
export type ChannelOpenRequest = z.infer<(typeof SystemChannelSchemas)['channel.open']['request']>;

/** Inferred response payload for the `system.channel.open` handshake. */
export type ChannelOpenResponse = z.infer<(typeof SystemChannelSchemas)['channel.open']['response']>;
