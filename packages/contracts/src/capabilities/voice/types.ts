import type { ICapabilityProvider } from '../../capability/types.js';
import type { STTResult, VoiceStatusState } from './schemas.js';
import type { STTMode, TTSMode } from './modes.js';

export type { STTResult, VoiceStatusState };

/** Runtime capabilities of an STT provider, used for provider selection. */
export interface STTProviderCapabilities {
  /** Supported transcription modes. */
  readonly modes: readonly STTMode[];
  /** Whether vocabulary/terminology biasing is supported. */
  readonly vocabularyBiasing: boolean;
}

/** Runtime capabilities of a TTS provider, used for provider selection. */
export interface TTSProviderCapabilities {
  /** Supported synthesis modes. */
  readonly modes: readonly TTSMode[];
  /** Whether voice preset selection is supported. */
  readonly voiceSelection: boolean;
  /** Whether style/tone instructions are supported. */
  readonly voiceInstructions: boolean;
  /** Supported output audio formats. */
  readonly outputFormats: readonly string[];
}

/** Where the provider executes — determines audio routing strategy. */
export type ProviderRuntime = 'server' | 'client';

/**
 * Raw audio input for speech-to-text transcription.
 */
export interface STTRequest {
  /** Raw PCM audio samples as a binary buffer */
  audio: ArrayBuffer;
  /** Sample rate of the audio in Hz (e.g. 16000, 44100) */
  sampleRate: number;
  /** BCP-47 language tag to guide transcription (e.g. "en-US") */
  language?: string;
  /** Custom vocabulary words to bias recognition toward */
  vocabulary?: string[];
}

/**
 * Text input for speech synthesis.
 */
export interface TTSRequest {
  /** Text to synthesize into audio */
  text: string;
  /** BCP-47 language tag for the desired voice (e.g. "en-US") */
  language?: string;
  /** Voice preset name (e.g. "default"). Provider uses its default if omitted. */
  voice?: string;
}

/**
 * A streamed chunk of synthesized PCM audio.
 * @remarks
 * This type is used exclusively in the local provider interface ({@link ITTSProvider}).
 * It is NOT JSON-serializable and must never appear as a bus event payload.
 * `Float32Array` does not survive JSON round-trips.
 */
export interface AudioChunk {
  /** Interleaved PCM float samples in the range [-1, 1] */
  data: Float32Array;
  /** Sample rate of this chunk in Hz */
  sampleRate: number;
}

/**
 * Speech-to-text capability provider.
 *
 * Providers implement audio transcription for the voice pipeline.
 * Register via the capability registry so the runtime can resolve the
 * active provider at session start.
 */
export interface ISTTProvider extends ICapabilityProvider {
  /** Discriminant that identifies the STT capability slot in the registry. */
  readonly capabilityId: 'stt';
  /** Where this provider runs. Server providers receive audio via WebSocket;
   *  client providers run locally in the browser/app. */
  readonly runtime: ProviderRuntime;
  /** Structured capabilities for provider selection. */
  readonly capabilities: STTProviderCapabilities;

  /**
   * Transcribe a raw audio buffer into text.
   * @param request - Audio data and transcription options
   * @returns Transcription result with detected language and optional confidence
   */
  transcribe(request: STTRequest): Promise<STTResult>;

  /**
   * Check whether this provider is ready to accept requests.
   * @returns `true` when the underlying adapter is initialised and reachable
   */
  isAvailable(): Promise<boolean>;
}

/**
 * Text-to-speech capability provider.
 *
 * Providers implement audio synthesis for the voice pipeline.
 * The response is an async iterable so callers can stream audio to
 * the client progressively without buffering the full utterance.
 */
export interface ITTSProvider extends ICapabilityProvider {
  /** Discriminant that identifies the TTS capability slot in the registry. */
  readonly capabilityId: 'tts';
  /** Where this provider runs. */
  readonly runtime: ProviderRuntime;
  /** Structured capabilities for provider selection. */
  readonly capabilities: TTSProviderCapabilities;

  /**
   * Synthesize text into a stream of PCM audio chunks.
   * @param request - Text content and optional language preference
   * @returns Async iterable of audio chunks, delivered in order
   */
  synthesize(request: TTSRequest): AsyncIterable<AudioChunk>;

  /**
   * Check whether this provider is ready to accept requests.
   * @returns `true` when the underlying adapter is initialised and reachable
   */
  isAvailable(): Promise<boolean>;
}

/** Strategy for a single voice pipeline leg (STT or TTS). */
export interface VoicePipelineLeg {
  /** Where processing runs. */
  readonly runtime: ProviderRuntime;
  /** Provider ID selected for this session. */
  readonly providerId: string;
  /** Display name for UI feedback. */
  readonly providerName: string;
}

/** Pipeline strategy returned to the client on voice session start. */
export interface VoicePipelineStrategy {
  /** How STT will work for this session. */
  readonly stt: VoicePipelineLeg;
  /** How TTS will work for this session. */
  readonly tts: VoicePipelineLeg;
}

/**
 * JSON-serializable descriptor for a client-runtime voice provider.
 *
 * Emitted across the bus for provider discovery; the actual executable
 * implementation is registered locally via `clientVoiceRuntimeRegistry`.
 */
export type ClientVoiceProviderDescriptor =
  | {
      /** Unique provider identifier. */
      readonly id: string;
      /** Human-readable name for UI. */
      readonly displayName: string;
      /** Always 'client' for client-side providers. */
      readonly runtime: 'client';
      /** Capability type this descriptor represents. */
      readonly capabilityId: 'stt';
      /** STT structured capabilities. */
      readonly capabilities: STTProviderCapabilities;
    }
  | {
      /** Unique provider identifier. */
      readonly id: string;
      /** Human-readable name for UI. */
      readonly displayName: string;
      /** Always 'client' for client-side providers. */
      readonly runtime: 'client';
      /** Capability type this descriptor represents. */
      readonly capabilityId: 'tts';
      /** TTS structured capabilities. */
      readonly capabilities: TTSProviderCapabilities;
    };

/** User preference for voice provider selection. */
export interface VoiceProviderPreference {
  /** Preferred STT provider ID, or 'auto' for best-available heuristic. */
  readonly stt: string;
  /** Preferred TTS provider ID, or 'auto' for best-available heuristic. */
  readonly tts: string;
}

/**
 * Provides context-derived vocabulary terms for ASR bias.
 *
 * Implementations extract terms from open files, codebase indexes,
 * or agent/session metadata. Used by VoiceService to merge with
 * user-managed vocabulary before transcription.
 *
 * Register via the capability registry with
 * `capabilityId: 'voice-vocabulary'` so VoiceService can discover
 * and query all active providers at transcription time.
 */
export interface IVocabularyProvider extends ICapabilityProvider {
  /** Discriminant that identifies the vocabulary capability slot in the registry. */
  readonly capabilityId: 'voice-vocabulary';

  /**
   * Get vocabulary terms relevant to the current session context.
   * @param sessionId - The active session
   * @returns Domain-specific terms to bias ASR toward
   */
  getTerms(sessionId: string): Promise<string[]>;
}
