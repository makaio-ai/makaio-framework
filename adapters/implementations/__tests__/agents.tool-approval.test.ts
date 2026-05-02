import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AIAgentConnector, ConformanceTestConfig, normalizeMessageInput } from '@makaio/ai-adapters-core';
import { getAdapterUnderTest, getAgentTestContext, TOOL_APPROVAL_SYSTEM_PROMPT } from './shared.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects } from '@makaio/contracts';

const adapterName = getAdapterUnderTest();

describe('Tool Approvals', async () => {
  const testContext = await getAgentTestContext(adapterName, true);
  const config = testContext.testConfig;

  const tmpDir = config.options?.tmpDir ?? os.tmpdir();
  const tmpFiles: string[] = [];
  const defaultTimeout = config.options?.defaultTimeout ?? 45_000;

  /**
   * Creates a unique temp file path and tracks it for cleanup.
   * Uses short identifiers to avoid LLM path truncation issues.
   * @param suffix - File suffix or extension to append before .txt
   * @param prefix - Optional prefix to prepend before "ta-" (e.g. "do-not-delete-")
   * @returns The full path to the created temp file
   */
  function createTempFile(suffix = '', prefix = ''): string {
    // Use short 8-char hex ID to keep paths under ~120 chars (LLMs truncate long paths)
    const shortId = crypto.randomUUID().slice(0, 8);
    const filename = `${prefix}ta-${shortId}${suffix}.txt`;
    const filepath = path.join(tmpDir, filename);
    tmpFiles.push(filepath);
    return filepath;
  }

  afterAll(() => {
    tmpFiles.forEach((file) => {
      if (fs.existsSync(file)) {
        try {
          fs.unlinkSync(file);
        } catch (error) {
          console.warn(`Failed to cleanup ${file}:`, error);
        }
      }
    });
  });

  describe('No Handler Recovery', () => {
    let agent: AIAgentConnector;
    let result: Awaited<ReturnType<AIAgentConnector['complete']>>;
    let tmpFile: string;

    beforeAll(async () => {
      // Create temp file path
      tmpFile = createTempFile('-no-handler');

      // Create connector WITHOUT registering a tool approval handler
      // Cast to access createConnector which is omitted from the testConfig type
      const fullConfig = testContext.testConfig as ConformanceTestConfig;
      agent = await fullConfig.createConnector({
        cwd: os.tmpdir(),
        reasoningEffort: config.options?.primaryModel?.reasoningEffort ?? 'low',
        agentId: crypto.randomUUID(),
        model: config.options?.primaryModel?.modelName,
      });

      // Start agent with a task that requires tool use (file write)
      // DO NOT register any tool approval handler
      const startResult = await agent.start(
        normalizeMessageInput(
          `Write the word HELLO to ${tmpFile} - pause IMMEDIATELY if first try failed. Reply with OK if file was written, otherwise with ERROR. ONLY reply with OK or ERROR (when in doubt, reply with ERROR).`,
        ),
        { systemPrompt: TOOL_APPROVAL_SYSTEM_PROMPT },
      );

      // Complete the task - should fail due to missing handler
      result = await startResult.messageHandle.waitForCompletion();
    }, defaultTimeout);

    // Two valid outcomes when no handler is registered:
    // 1. LLM attempts tool → approval fails → outcome: 'error' with handler message
    // 2. LLM decides not to attempt tool → outcome: 'completed' with "ERROR" text
    // Both are acceptable - the security property (file not created) is what matters

    it('fails or gives up when no tool approval handler is registered', { timeout: defaultTimeout }, () => {
      expect(result).toBeDefined();
      expect(['error', 'completed']).toContain(result?.outcome);
    });

    it('error message indicates missing handler (when tool was attempted)', { timeout: defaultTimeout }, () => {
      // Only assert on error message if outcome was 'error' (LLM attempted the tool)
      if (result?.outcome !== 'error') {
        // LLM didn't attempt tool - skip this assertion
        return;
      }

      const error = result?.error as Error;
      expect(error).toBeDefined();

      if (!error.message) {
        console.error('Error has no message', JSON.stringify(error));
      }
      expect(error.message).toBeDefined();

      // Different adapters produce different error messages:
      // - claude-code, copilot, codex: "Tool approval request failed, make sure that there's a handler registered: ..."
      // - openai-node, gemini-sdk: "Request to \"..._approval\" failed: Handler completed without setting a result"
      // Common indicator is the word "handler" (case-insensitive)
      expect(error.message.toLowerCase()).toContain('handler');
    });

    it('tool does not execute (file not created)', { timeout: defaultTimeout }, () => {
      // This is the key security property - regardless of how we got here
      expect(fs.existsSync(tmpFile)).toBe(false);
    });
  });

  describe('Soft Denial', { timeout: defaultTimeout }, () => {
    let agent: AIAgentConnector;
    let agentId: string;
    let result: Awaited<ReturnType<AIAgentConnector['complete']>>;
    let tmpFile: string;
    let denialCount = 0;
    let unsubscribe: (() => void) | undefined;

    beforeAll(async () => {
      // Codex auto-approves `rm` on generic temp files. The "do-not-delete-" prefix
      // makes its trust model treat the operation as dangerous, forcing approval.
      // Other adapters use a neutral name so the model doesn't refuse tool use outright.
      const prefix = adapterName.includes('codex') ? 'do-not-delete-' : '';
      tmpFile = createTempFile('-sd', prefix);
      fs.writeFileSync(tmpFile, 'DO NOT DELETE');
      denialCount = 0;
      agent = await testContext.createConnector();
      agentId = agent.getAgentId();

      // Register approval handler that denies with shouldAbort: false
      unsubscribe = MakaioBus.on(
        AgentSubjects.toolApprove,
        (context) => {
          denialCount++;
          context.setResult({
            action: 'deny',
            message: 'you MUST IMMEDIATELY stop and ask user for direction',
            shouldAbort: false,
          });
        },
        { filter: { agentId } },
      );

      // Codex auto-approves safe file operations, so ask it to both write and
      // delete the file — at least one of those will trigger an approval request.
      let prompt = `Delete the file ${tmpFile} - pause IMMEDIATELY if first try failed. Reply with OK if file was deleted, otherwise with ERROR. ONLY reply with OK or ERROR (when in doubt, reply with ERROR).`;
      if (adapterName.includes('codex')) {
        prompt = `Use shell_command tool to first write "updated" to ${tmpFile} and then delete it. Pause IMMEDIATELY after any failed attempt. Reply with OK if the file was deleted, otherwise with ERROR. ONLY reply with OK or ERROR (when in doubt, reply with ERROR).`;
      }

      // Start agent
      const startResult = await agent.start(normalizeMessageInput(prompt), {
        systemPrompt: TOOL_APPROVAL_SYSTEM_PROMPT,
      });

      // Complete the task
      result = await startResult.messageHandle.waitForCompletion();
    }, defaultTimeout);

    afterAll(() => {
      unsubscribe?.();
    });

    it('denies tool with shouldAbort: false', { timeout: defaultTimeout }, () => {
      expect(denialCount).toBeGreaterThan(0);
    });

    it('agent receives denial message', { timeout: defaultTimeout }, () => {
      // Agent should complete (not error out) since shouldAbort: false
      // The outcome depends on implementation - agent may retry or complete with message
      expect(result).toBeDefined();
    });

    it('agent may retry or complete', { timeout: defaultTimeout }, () => {
      // With shouldAbort: false, agent has flexibility to:
      // - Retry with different approach
      // - Complete with message explaining the situation
      // - Either outcome is acceptable
      expect(['completed', 'error']).toContain(result?.outcome);
    });

    it('tool does not execute (file still exists)', { timeout: defaultTimeout }, () => {
      // Despite retries, tool should not execute since we always deny
      expect(fs.existsSync(tmpFile)).toBe(true);
    });
  });

  describe('Hard Denial', () => {
    let agent: AIAgentConnector;
    let agentId: string;
    let result: Awaited<ReturnType<AIAgentConnector['complete']>>;
    let tmpFile: string;
    let unsubscribe: (() => void) | undefined;

    beforeAll(async () => {
      tmpFile = createTempFile('-hard-deny');
      agent = await testContext.createConnector();
      agentId = agent.getAgentId();

      // Register approval handler that denies with shouldAbort: true
      unsubscribe = MakaioBus.on(
        AgentSubjects.toolApprove,
        (context) => {
          context.setResult({
            action: 'deny',
            message: 'Access forbidden - aborting execution',
            shouldAbort: true,
          });
        },
        { filter: { agentId } },
      );

      // elicitation/create
      let prompt = `Write the word HELLO to ${tmpFile}. Reply with OK if successful, otherwise with ERROR.`;
      if (adapterName.includes('codex')) {
        prompt = `Use shell_command tool to write the word HELLO to ${tmpFile}. Reply with OK if successful, otherwise with ERROR. I gave you full access now, try again, otherwise you MUST reply only with: ERROR`;
      }

      // Start agent
      const startResult = await agent.start(normalizeMessageInput(prompt), {
        systemPrompt: TOOL_APPROVAL_SYSTEM_PROMPT,
      });

      // Complete the task
      result = await startResult.messageHandle.waitForCompletion();
    }, config.options?.defaultTimeout ?? 45_000);

    afterAll(() => {
      unsubscribe?.();
    });

    // Two valid outcomes when handler denies with shouldAbort: true:
    // 1. LLM attempts tool → handler denies → outcome: 'error' with denial message
    // 2. LLM decides not to attempt tool → outcome: 'completed' with "ERROR" text
    // Both are acceptable - the security property (file not created) is what matters

    it('denies tool with shouldAbort: true', { timeout: defaultTimeout }, () => {
      expect(result).toBeDefined();
    });

    it('agent terminates or gives up', { timeout: defaultTimeout }, () => {
      // With shouldAbort: true, agent should terminate with error if tool was attempted
      // OR complete with a message if LLM gave up without attempting
      expect(['error', 'completed']).toContain(result?.outcome);
    });

    it('tool does not execute (file not created)', { timeout: defaultTimeout }, () => {
      // This is the key security property - regardless of how we got here
      expect(fs.existsSync(tmpFile)).toBe(false);
    });

    it('error message reflects denial (when tool was attempted)', { timeout: defaultTimeout }, () => {
      // Only assert on error message if outcome was 'error' (LLM attempted the tool)
      if (result?.outcome !== 'error') {
        // LLM didn't attempt tool - skip this assertion
        return;
      }

      const error = result?.error as Error;
      expect(error).toBeDefined();
      expect(error.message).toBeDefined();
      // Error should indicate denial or forbidden access
      expect(error.message).toContain('Tool use denied by approval handler:');
    });
  });

  describe('Success', () => {
    describe('Simple Allow', () => {
      let agent: AIAgentConnector;
      let agentId: string;
      let result: Awaited<ReturnType<AIAgentConnector['complete']>>;
      let tmpFile: string;
      let approvalRequest:
        | {
            toolName: string;
            args: Record<string, unknown>;
            toolCallId: string;
          }
        | undefined;
      let unsubscribe: (() => void) | undefined;

      beforeAll(async () => {
        tmpFile = createTempFile('-simple-allow');
        agent = await testContext.createConnector();
        agentId = agent.getAgentId();

        // Register approval handler that captures request details
        unsubscribe = MakaioBus.on(
          AgentSubjects.toolApprove,
          (context) => {
            approvalRequest = {
              toolName: context.payload.toolName!,
              args: context.payload.args!,
              toolCallId: context.payload.toolCallId,
            };
            context.setResult({ action: 'allow' });
          },
          { filter: { agentId } },
        );

        // Start agent
        await agent.start(
          normalizeMessageInput(
            `Do NOT think too much, it's a simple task: Write the word HELLO to ${tmpFile} - reply with OK if successful, otherwise with ERROR`,
          ),
          { systemPrompt: TOOL_APPROVAL_SYSTEM_PROMPT },
        );

        // Complete the task
        result = await agent.complete();
      }, defaultTimeout);

      afterAll(() => {
        unsubscribe?.();
      });

      it('requests approval via agent.toolApprove', { timeout: defaultTimeout }, () => {
        expect(approvalRequest).toBeDefined();
      });

      it('includes toolName and args in request', { timeout: defaultTimeout }, () => {
        expect(approvalRequest?.toolName).toBeDefined();
        // Tool names vary by adapter: Claude uses 'Write'/'bash', Codex uses 'exec'/'patch'
        expect(approvalRequest?.toolName).toBeTypeOf('string');
        expect(approvalRequest?.args).toBeDefined();
        expect(approvalRequest?.args).toBeTypeOf('object');
      });

      it('includes toolCallId in request', { timeout: defaultTimeout }, () => {
        expect(approvalRequest?.toolCallId).toBeDefined();
        expect(approvalRequest?.toolCallId).toBeTypeOf('string');
      });

      it('executes tool after approval', { timeout: defaultTimeout }, () => {
        // Verify file was created (side effect of tool execution)
        expect(fs.existsSync(tmpFile)).toBe(true);
      });

      it('completes successfully', { timeout: defaultTimeout }, () => {
        expect(result?.outcome).toBe('completed');
        expect(result?.error).toBeUndefined();
      });

      it('produces expected side effect (file written)', { timeout: defaultTimeout }, () => {
        expect(fs.existsSync(tmpFile)).toBe(true);
        const content = fs.readFileSync(tmpFile, 'utf-8');
        expect(content.trim()).toMatch(/HELLO/i);
      });
    });
  });
});
