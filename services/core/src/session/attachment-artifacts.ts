import type { SessionMessageBlock } from '@makaio/contracts';

/** Narrowed entry for attachment blocks, preserving the original block index. */
interface AttachmentEntry {
  block: Extract<SessionMessageBlock, { type: 'attachment' }>;
  blockIndex: number;
}

/**
 * Minimal descriptor for a session-scoped attachment artifact.
 *
 * Defined here so the framework core remains independent of any host plugin.
 * The host (host layer) owns the full storage schema; this type covers only
 * the fields that `createAttachmentArtifacts` needs to populate.
 */
/** Metadata linking an attachment artifact back to its originating message. */
export interface AttachmentArtifactMetadata extends Record<string, unknown> {
  /** Message that contained the attachment. */
  messageId: string;
  /** Position of the attachment block within the message's blocks array. */
  blockIndex: number;
  /** Original file name of the attachment. */
  fileName?: string;
}

export interface AttachmentArtifactInput {
  /** Unique artifact identifier. */
  id: string;
  /** Always 'session' for attachment artifacts created from message blocks. */
  scope: 'session';
  /** Session the artifact belongs to. */
  sessionId: string;
  /** Always 'user-upload' for attachment artifacts. */
  type: 'user-upload';
  /** MIME type of the attached file. */
  mimeType: string;
  /** Absolute file path on disk, when available. */
  filePath?: string;
  /** Base64-encoded content, when the source was base64 data. */
  content?: string;
  /** Structured metadata linking the artifact back to its origin. */
  metadata: AttachmentArtifactMetadata;
}

/**
 * Result of a single artifact store attempt.
 *
 * Mirrors the optional-result discriminated-union shape returned by
 * `IMakaioBus.requestOptional` so the host can signal whether the artifacts
 * plugin was available without coupling the framework to the bus API.
 */
export type StoreArtifactResult = { handled: true; data: { id: string } } | { handled: false };

/**
 * Host-provided callback that persists one attachment artifact.
 *
 * Injected by the host layer so that `createAttachmentArtifacts` stays
 * free of host plugin imports.  Returning `{ handled: false }` signals
 * that the artifacts plugin is not loaded; the caller logs a warning but
 * never fails the parent request.
 * @param artifact - The artifact descriptor to store.
 * @returns A promise resolving to a {@link StoreArtifactResult}.
 */
export type StoreArtifactFn = (artifact: AttachmentArtifactInput) => Promise<StoreArtifactResult>;

/**
 * Creates session-scoped artifacts for attachment blocks in a user message.
 *
 * Called after message storage. Delegates persistence to `storeArtifact` so
 * this function remains free of host plugin dependencies — the host
 * (host layer) owns the storage subject and wires the bus call.
 *
 * Breaking change: previously accepted `IMakaioBus` and relied on the
 * artifacts storage subject from `@makaio/contracts`. The callback signature
 * decouples the framework from that bus + subject wiring.
 *
 * Each attachment block becomes a `user-upload` artifact in the session scope,
 * with metadata linking it back to the originating message.
 * @param storeArtifact - Host-provided callback to persist one artifact
 * @param sessionId - Session containing the message
 * @param messageId - Message containing the attachments
 * @param blocks - Normalized message blocks (already stored)
 */
export async function createAttachmentArtifacts(
  storeArtifact: StoreArtifactFn,
  sessionId: string,
  messageId: string,
  blocks: SessionMessageBlock[],
): Promise<void> {
  // Map over the original blocks array so metadata.blockIndex always points to the
  // true position in message.blocks (not the index inside a filtered subset).
  // Each write is independent, so run them concurrently via Promise.allSettled.
  const promises = blocks
    .map((block, blockIndex) => ({ block, blockIndex }))
    .filter((item): item is AttachmentEntry => item.block.type === 'attachment')
    .map(async ({ block, blockIndex }) => {
      const mimeType = block.source.mimeType ?? 'application/octet-stream';
      const content = block.source.type === 'base64' ? block.source.data : undefined;

      try {
        const result = await storeArtifact({
          // Repo convention intentionally uses the global Web Crypto UUID API:
          // our minimum runtime is Node >=22, and importing from node:crypto
          // here would add a one-off variant of the same UUID contract.
          id: crypto.randomUUID(),
          scope: 'session',
          sessionId,
          type: 'user-upload',
          mimeType,
          filePath: block.filePath,
          ...(content !== undefined && { content }),
          metadata: {
            messageId,
            blockIndex,
            fileName: block.fileName,
          },
        });

        // Artifacts plugin is optional. Log for observability, but never fail sendMessage.
        if (!result.handled) {
          console.warn('[SessionOrchestrator] Artifacts handler unavailable for attachment artifact creation', {
            sessionId,
            messageId,
            blockIndex,
            fileName: block.fileName,
          });
        }
      } catch (error) {
        // Degrade gracefully when artifact persistence fails.
        console.warn('[SessionOrchestrator] Failed to persist attachment artifact', {
          sessionId,
          messageId,
          blockIndex,
          fileName: block.fileName,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

  await Promise.allSettled(promises);
}
