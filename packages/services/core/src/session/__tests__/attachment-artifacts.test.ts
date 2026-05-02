/**
 * Unit tests for createAttachmentArtifacts.
 *
 * Covers:
 * - Single attachment block → one session artifact with type 'user-upload'
 * - Artifact carries correct filePath, mimeType, and fileName in metadata
 * - Text-only blocks → no artifact created (no storeArtifact calls)
 * - Multiple attachment blocks → one artifact per block
 * - Artifact carries the correct sessionId
 *
 * Uses a plain in-memory `storeArtifact` callback — no bus setup needed —
 * so the tests are independent of the host artifacts plugin.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { SessionMessageBlock } from '@makaio/contracts';
import {
  createAttachmentArtifacts,
  type AttachmentArtifactInput,
  type StoreArtifactFn,
} from '../attachment-artifacts.js';

// ----- Helpers -----

/**
 * Builds a minimal valid attachment block for test fixtures.
 * @param overrides - Partial fields to merge over defaults
 * @returns A SessionMessageBlock of type 'attachment'
 */
function makeAttachmentBlock(
  overrides: Partial<Extract<SessionMessageBlock, { type: 'attachment' }>> = {},
): Extract<SessionMessageBlock, { type: 'attachment' }> {
  return {
    type: 'attachment',
    fileName: 'report.pdf',
    filePath: '/uploads/report.pdf',
    source: { type: 'base64', data: 'dGVzdA==', mimeType: 'application/pdf' },
    attachmentType: 'file',
    ...overrides,
  };
}

/**
 * Creates a text-only block.
 * @param content - Text content for the block
 */
function makeTextBlock(content = 'Hello'): Extract<SessionMessageBlock, { type: 'text' }> {
  return { type: 'text', content };
}

// ----- Shared test state -----

let capturedArtifacts: AttachmentArtifactInput[];
let storeArtifact: StoreArtifactFn;

// ----- Tests -----

describe('createAttachmentArtifacts', () => {
  beforeEach(() => {
    capturedArtifacts = [];
    storeArtifact = async (artifact) => {
      capturedArtifacts.push(artifact);
      return { handled: true, data: { id: artifact.id } };
    };
  });

  it('creates one artifact for a message with a single attachment block', async () => {
    const blocks: SessionMessageBlock[] = [makeAttachmentBlock()];

    await createAttachmentArtifacts(storeArtifact, 'session-1', 'msg-1', blocks);

    expect(capturedArtifacts).toHaveLength(1);
  });

  it('artifact has type user-upload and correct filePath, mimeType, and fileName metadata', async () => {
    const block = makeAttachmentBlock({
      fileName: 'api-spec.yaml',
      filePath: '/uploads/api-spec.yaml',
      source: { type: 'base64', data: 'dGVzdA==', mimeType: 'application/yaml' },
    });

    await createAttachmentArtifacts(storeArtifact, 'session-1', 'msg-1', [block]);

    const artifact = capturedArtifacts[0];
    expect(artifact).toBeDefined();
    expect(artifact.type).toBe('user-upload');
    expect(artifact.filePath).toBe('/uploads/api-spec.yaml');
    expect(artifact.mimeType).toBe('application/yaml');
    expect(artifact.metadata).toMatchObject({ fileName: 'api-spec.yaml' });
  });

  it('creates no artifacts for a message with only text blocks', async () => {
    const blocks: SessionMessageBlock[] = [makeTextBlock('Hi there'), makeTextBlock('More text')];

    await createAttachmentArtifacts(storeArtifact, 'session-1', 'msg-1', blocks);

    expect(capturedArtifacts).toHaveLength(0);
  });

  it('creates one artifact per attachment block for a mixed or multi-attachment message', async () => {
    const blocks: SessionMessageBlock[] = [
      makeAttachmentBlock({ fileName: 'image.png', filePath: '/uploads/image.png' }),
      makeTextBlock('description'),
      makeAttachmentBlock({ fileName: 'doc.pdf', filePath: '/uploads/doc.pdf' }),
    ];

    await createAttachmentArtifacts(storeArtifact, 'session-2', 'msg-2', blocks);

    expect(capturedArtifacts).toHaveLength(2);
    const fileNames = capturedArtifacts.map((a) => a.metadata.fileName);
    expect(fileNames).toContain('image.png');
    expect(fileNames).toContain('doc.pdf');
  });

  it('artifact carries the correct sessionId', async () => {
    const blocks: SessionMessageBlock[] = [makeAttachmentBlock()];

    await createAttachmentArtifacts(storeArtifact, 'session-xyz', 'msg-1', blocks);

    expect(capturedArtifacts[0].sessionId).toBe('session-xyz');
  });

  it('does not throw when storeArtifact returns handled=false', async () => {
    storeArtifact = async (artifact) => {
      capturedArtifacts.push(artifact);
      return { handled: false };
    };
    const blocks: SessionMessageBlock[] = [makeAttachmentBlock()];

    await expect(createAttachmentArtifacts(storeArtifact, 'session-1', 'msg-1', blocks)).resolves.toBeUndefined();
    expect(capturedArtifacts).toHaveLength(1);
  });

  it('does not throw when storeArtifact throws', async () => {
    let calls = 0;
    storeArtifact = async () => {
      calls += 1;
      throw new Error('storage down');
    };
    const blocks: SessionMessageBlock[] = [makeAttachmentBlock()];

    await expect(createAttachmentArtifacts(storeArtifact, 'session-1', 'msg-1', blocks)).resolves.toBeUndefined();
    expect(calls).toBe(1);
  });
});
