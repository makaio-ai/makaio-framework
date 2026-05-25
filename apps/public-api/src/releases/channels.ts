import { KNOWN_CHANNELS, type Channel } from './types.js';

/**
 * Parse the release channel from an artifact filename.
 * @param artifact - Full artifact filename (e.g. `stable-macos-arm64-update.json`).
 * @returns The channel, or `null` if the filename doesn't match a known channel.
 */
export function parseChannel(artifact: string): Channel | null {
  for (const channel of KNOWN_CHANNELS) {
    if (artifact.startsWith(`${channel}-`)) return channel;
  }
  return null;
}

/**
 * Check whether an artifact filename is an update.json metadata file.
 * @param artifact - Full artifact filename.
 * @returns `true` if the filename ends with `-update.json`.
 */
export function isUpdateJson(artifact: string): boolean {
  return artifact.endsWith('-update.json');
}
