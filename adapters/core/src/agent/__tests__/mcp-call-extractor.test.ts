import { describe, it, expect } from 'vitest';
import { extractMcpCallTarget, isMcpCallTool } from '../mcp-call-extractor.js';
import { MCP_CALL_TOOL_NAME } from '@makaio/contracts';

describe('extractMcpCallTarget', () => {
  it('extracts tool name from conformant args', () => {
    expect(extractMcpCallTarget({ tool: 'github__create_issue' })).toBe('github__create_issue');
  });

  it('returns undefined for missing tool key', () => {
    expect(extractMcpCallTarget({})).toBeUndefined();
  });

  it('returns undefined for non-string tool value', () => {
    expect(extractMcpCallTarget({ tool: 42 })).toBeUndefined();
  });

  it('returns undefined for null tool value', () => {
    expect(extractMcpCallTarget({ tool: null })).toBeUndefined();
  });
});

describe('isMcpCallTool', () => {
  it('returns true for mcp_call', () => {
    expect(isMcpCallTool(MCP_CALL_TOOL_NAME)).toBe(true);
  });

  it('returns false for other tool names', () => {
    expect(isMcpCallTool('other_tool')).toBe(false);
  });
});

describe('cross-schema contract', () => {
  it('extractMcpCallTarget matches the mcp_call input schema contract', () => {
    // The mcp_call input schema defines { tool: z.string() }
    // This test verifies the extractor agrees with that schema
    const conformantArgs = { tool: 'github__create_issue', arguments: { title: 'test' } };
    expect(extractMcpCallTarget(conformantArgs)).toBe('github__create_issue');
  });
});
