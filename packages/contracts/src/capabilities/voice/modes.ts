/**
 * Canonical STT mode literals shared across contracts and model schemas.
 */
export const STT_MODE_LITERALS = ['batch', 'streaming'] as const;

/**
 * Canonical TTS mode literals shared across contracts and model schemas.
 */
export const TTS_MODE_LITERALS = ['buffered', 'streaming'] as const;

/** Speech-to-text mode union type. */
export type STTMode = (typeof STT_MODE_LITERALS)[number];

/** Text-to-speech mode union type. */
export type TTSMode = (typeof TTS_MODE_LITERALS)[number];
