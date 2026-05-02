import { MakaioBus } from '@makaio/bus-core';
import { VoiceSchemas } from './schemas.js';

/**
 * Registered MakaioBus namespace for voice session events and RPCs.
 *
 * This is the canonical public namespace definition for the `voice.*`
 * contract and should be imported by all producers/consumers.
 */
export const VoiceNamespace = MakaioBus.registerNamespace('voice', VoiceSchemas);

/**
 * Typed subject tree for the voice namespace.
 *
 * Use this for all emit/request/on calls instead of raw string subjects.
 */
export const VoiceSubjects = VoiceNamespace.subjects;
