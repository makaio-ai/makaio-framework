import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toolsetToMcpTools } from '@makaio/tools-core';
import { createArtifactPatchToolset } from '../toolset.js';
import type { ArtifactPatchHost } from '../patch-artifact.js';

const host: ArtifactPatchHost = {
  listKinds: async () => [],
  resolveCurrent: async () => null,
  store: async () => {
    throw new Error('not reached');
  },
};

describe('MCP facade', () => {
  it('exports the subject request contract as the tool input schema', () => {
    const toolset = createArtifactPatchToolset(host);
    const tool = toolset.tools.artifacts_patch;

    // The facade adds no translation layer, so what an agent sees is the wire contract itself.
    expect(z.toJSONSchema(tool.inputSchema, { io: 'input' })).toMatchObject({
      type: 'object',
      required: ['ref', 'baseRevision', 'patch'],
      additionalProperties: false,
    });
  });

  it('describes the declared operators to an MCP client without losing the closed operator set', () => {
    const toolset = createArtifactPatchToolset(host);

    const exported = toolsetToMcpTools(toolset);
    const tool = exported.find((candidate) => candidate.name === 'artifacts_patch');
    const patch = tool?.inputSchema.properties?.patch;

    expect(patch).toMatchObject({ type: 'object', additionalProperties: false });
    expect(Object.keys((patch as { properties: Record<string, unknown> }).properties).sort()).toStrictEqual([
      '$pull',
      '$push',
      '$set',
      '$unset',
      'arrayFilters',
    ]);
  });

  it('announces the tool as a write', () => {
    const toolset = createArtifactPatchToolset(host);

    expect(toolset.tools.artifacts_patch.metadata.annotations).toMatchObject({ readOnly: false });
  });
});
