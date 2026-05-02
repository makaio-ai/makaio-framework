import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';
import type { VoicePipelineLeg, VoicePipelineStrategy } from './types.js';

/**
 * Transcription result produced by an STT provider.
 */
export const STTResultSchema = z.object({
  /** Transcribed text */
  text: z.string(),
  /** BCP-47 language tag detected or used during transcription */
  language: z.string(),
  /** Confidence score in the range [0, 1], if available */
  confidence: z.number().optional(),
});

export type STTResult = z.infer<typeof STTResultSchema>;

/** Voice pipeline lifecycle state emitted by `voice.status`. */
export const VoiceStatusStateSchema = z.enum(['idle', 'recording', 'transcribing', 'synthesizing', 'error']);
export type VoiceStatusState = z.infer<typeof VoiceStatusStateSchema>;

/**
 * A single pipeline leg (STT or TTS) within a voice session strategy.
 *
 * Inlined here so the schema can be referenced by `session.start` response
 * without creating a circular dependency with `types.ts`.
 */
export const VoicePipelineLegSchema = z.object({
  /** Where processing runs. */
  runtime: z.enum(['server', 'client']),
  /** Provider ID selected for this session. */
  providerId: z.string(),
  /** Display name for UI feedback. */
  providerName: z.string(),
});
/**
 * Canonical owner: `types.ts` (schema stays runtime source, interface stays type source).
 * Keep this alias for API compatibility while preventing duplicate ownership drift.
 */
export type VoicePipelineLegSchemaType = VoicePipelineLeg;

/**
 * Full pipeline strategy for an active voice session.
 *
 * Returned inside `voice.session.start` responses so the client knows which
 * providers handle STT and TTS, and whether it must connect a WebSocket.
 */
export const VoicePipelineStrategySchema = z.object({
  /** How STT will work for this session. */
  stt: VoicePipelineLegSchema,
  /** How TTS will work for this session. */
  tts: VoicePipelineLegSchema,
});
/**
 * Canonical owner: `types.ts` (schema stays runtime source, interface stays type source).
 * Keep this alias for API compatibility while preventing duplicate ownership drift.
 */
export type VoicePipelineStrategySchemaType = VoicePipelineStrategy;

/**
 * Voice capability bus subjects.
 *
 * Each key becomes a subject identifier as: `voice.{key}`
 * @example
 * ```typescript
 * // Start a voice session (server-side audio transport)
 * const result = await bus.request(VoiceSubjects['session.start'], { sessionId });
 * if (result.audioTransport === 'ws') {
 *   connectAudioSocket(result.audioWsUrl, result.bindToken);
 * }
 *
 * // Subscribe to live transcription events
 * bus.on(VoiceSubjects.transcription, (ctx) => {
 *   console.log(ctx.payload.text);
 * });
 * ```
 */
export const VoiceSchemas = {
  // ─────────────────────────────────────────────────────────────────────────
  // RPCs
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Start a voice session and receive the resolved pipeline strategy.
   *
   * The response is a discriminated union on `audioTransport`:
   * - `'none'` — all processing is client-side; no WebSocket is needed.
   * - `'ws'`   — server-side audio transport; connect to `audioWsUrl` using `bindToken`.
   *
   * Subject: `voice.session.start`
   * Type: Request (RPC)
   */
  'session.start': {
    request: z.object({
      /** Unique identifier for the session to start */
      sessionId: z.string(),
    }),
    response: z.discriminatedUnion('audioTransport', [
      z.object({
        /** No server-side audio transport required for this session. */
        audioTransport: z.literal('none'),
        /** Resolved pipeline strategy for this session. */
        strategy: VoicePipelineStrategySchema,
      }),
      z.object({
        /** Server-side WebSocket audio transport required for this session. */
        audioTransport: z.literal('ws'),
        /** WebSocket URL the client should connect to for bidirectional audio. */
        audioWsUrl: z.string().url(),
        /** One-time secret required by the initial audio WebSocket bind frame. */
        bindToken: z.string(),
        /** Resolved pipeline strategy for this session. */
        strategy: VoicePipelineStrategySchema,
      }),
    ]),
  },

  /**
   * Stop an active voice session.
   *
   * Subject: `voice.session.stop`
   * Type: Request (RPC)
   */
  'session.stop': {
    request: z.object({
      /** Unique identifier of the session to stop */
      sessionId: z.string(),
    }),
    response: z.object({}),
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Events
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Emitted when a complete transcription is available for a session.
   *
   * Subject: `voice.transcription`
   * Type: Event
   */
  transcription: STTResultSchema.extend({
    /** Session that produced this transcription */
    sessionId: z.string(),
    /** Message created from this transcription, when available */
    messageId: z.string().optional(),
  }),

  /**
   * Emitted when TTS synthesis begins for a message.
   *
   * Subject: `voice.synthesis.start`
   * Type: Event
   */
  'synthesis.start': z.object({
    /** Session in which synthesis is happening */
    sessionId: z.string(),
    /** Identifier of the message being synthesised, if available */
    messageId: z.string().optional(),
  }),

  /**
   * Emitted when TTS synthesis completes for a message.
   *
   * Subject: `voice.synthesis.end`
   * Type: Event
   */
  'synthesis.end': z.object({
    /** Session in which synthesis completed */
    sessionId: z.string(),
    /** Identifier of the message that finished synthesising, if available */
    messageId: z.string().optional(),
  }),

  /**
   * Emitted when the voice pipeline state changes.
   *
   * Subject: `voice.status`
   * Type: Event
   */
  status: z.object({
    /** Session whose state changed */
    sessionId: z.string(),
    /** Current pipeline state */
    state: VoiceStatusStateSchema,
  }),
} satisfies SchemaRecord;

/** Discriminated response payload for the `voice.session.start` RPC. */
export type VoiceSessionStartResponse = z.infer<(typeof VoiceSchemas)['session.start']['response']>;

/**
 * Runtime validator for {@link VoiceProviderPreference}.
 *
 * Used to safely parse persisted preference values from storage, where the
 * on-disk data may be corrupted or from an older schema version.
 * Falls back to the default preference when the stored value does not conform.
 */
export const VoiceProviderPreferenceSchema = z.object({
  /** Preferred STT provider ID, or `'auto'` for best-available heuristic. */
  stt: z.string(),
  /** Preferred TTS provider ID, or `'auto'` for best-available heuristic. */
  tts: z.string(),
});
