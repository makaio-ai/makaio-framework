import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { AgentSubjects, AdapterSubjects, AgentSchemas } from '@makaio/contracts';
import { OpenCodeLogImporter } from '../src/importer.js';

const createImporter = () =>
  new OpenCodeLogImporter({
    adapterId: 'test-import',
    adapterName: 'opencode',
  });

const loadFixture = (name: string): string => {
  const fixturePath = join(__dirname, 'fixtures', name);
  return readFileSync(fixturePath, 'utf-8');
};

interface StorageFixtureSetup {
  sessionFilePath: string;
}

function setupStorageFixtures(testStorageDir: string): StorageFixtureSetup {
  const sessionId = 'ses_43d462e9cffexz6719QK96K7Ei';
  const userMsgId = 'msg_bb815fae3001NfwSfS3QMC3yzU';
  const assistantMsgId = 'msg_bbc7965ee0013MiAht130lgpXk';
  const storageRoot = join(testStorageDir, 'project', 'test-slug', 'storage');
  const sessionFilePath = join(storageRoot, 'session', sessionId, 'session.json');

  mkdirSync(join(storageRoot, 'session', sessionId), { recursive: true });
  mkdirSync(join(storageRoot, 'message', sessionId), { recursive: true });
  mkdirSync(join(storageRoot, 'part', userMsgId), { recursive: true });
  mkdirSync(join(storageRoot, 'part', assistantMsgId), { recursive: true });

  writeFileSync(sessionFilePath, loadFixture('session.json'));
  writeFileSync(join(storageRoot, 'message', sessionId, `${userMsgId}.json`), loadFixture('message-user.json'));
  writeFileSync(
    join(storageRoot, 'message', sessionId, `${assistantMsgId}.json`),
    loadFixture('message-assistant.json'),
  );
  writeFileSync(
    join(storageRoot, 'part', userMsgId, 'prt_bb815fae3002ueqHdjhAOYByr0.json'),
    loadFixture('part-text-user.json'),
  );
  writeFileSync(
    join(storageRoot, 'part', assistantMsgId, 'prt_bbc7965ee002XYZabc123.json'),
    loadFixture('part-text-assistant.json'),
  );
  writeFileSync(
    join(storageRoot, 'part', assistantMsgId, 'prt_bbc796e5a001PjEXcYdNV478Wo.json'),
    loadFixture('part-tool.json'),
  );
  writeFileSync(
    join(storageRoot, 'part', assistantMsgId, 'prt_bbc796e5a002StepFinish.json'),
    loadFixture('part-step-finish.json'),
  );

  return { sessionFilePath };
}

describe('OpenCodeLogImporter', () => {
  let testStorageDir: string;

  beforeEach(() => {
    // Create a temporary storage directory for tests
    testStorageDir = join(tmpdir(), `opencode-test-${Date.now()}`);
    mkdirSync(testStorageDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up test directory
    if (testStorageDir) {
      rmSync(testStorageDir, { recursive: true, force: true });
    }
  });

  describe('getLogDirectory', () => {
    it('returns ~/.local/share/opencode/storage/', () => {
      const importer = createImporter();
      // Per OpenCode docs, all platforms use ~/.local/share/opencode/
      // Session files are in {project|global}/storage/session/{uuid}/
      // getLogDirectory() returns the storage root for direct file lookups
      const expectedPath = join(homedir(), '.local', 'share', 'opencode', 'storage');
      expect(importer.getLogDirectory()).toBe(expectedPath);
    });
  });

  describe('canHandle', () => {
    it('recognizes valid OpenCode session JSON', () => {
      const importer = createImporter();
      const sessionJson = loadFixture('session.json');
      expect(importer.canHandle(sessionJson)).toBe(true);
    });

    it('recognizes valid OpenCode session object', () => {
      const importer = createImporter();
      const sessionJson = loadFixture('session.json');
      const sessionObj = JSON.parse(sessionJson);
      expect(importer.canHandle(sessionObj)).toBe(true);
    });

    it('rejects invalid JSON', () => {
      const importer = createImporter();
      expect(importer.canHandle('not json')).toBe(false);
    });

    it('rejects objects missing required fields', () => {
      const importer = createImporter();
      expect(importer.canHandle('{"id": "123"}')).toBe(false);
      expect(importer.canHandle('{"id": "123", "slug": "test"}')).toBe(false);
    });
  });

  describe('parseRecord', () => {
    it('parses valid session JSON', () => {
      const importer = createImporter();
      const sessionJson = loadFixture('session.json');
      const session = importer.parseRecord(sessionJson);

      expect(session).not.toBeNull();
      expect(session!.session.id).toBe('ses_43d462e9cffexz6719QK96K7Ei');
      expect(session!.session.projectID).toBe('306ec0503454c53557861e73d40bcc85e6bf41be');
      expect(session!.session.directory).toBe('/home/user/source-workspace/terminal');
    });

    it('returns null for invalid JSON', () => {
      const importer = createImporter();
      expect(importer.parseRecord('not json')).toBeNull();
    });

    it('returns null for missing required fields', () => {
      const importer = createImporter();
      expect(importer.parseRecord('{"foo": "bar"}')).toBeNull();
    });

    it('returns empty messages and parts arrays', () => {
      const importer = createImporter();
      const sessionJson = loadFixture('session.json');
      const session = importer.parseRecord(sessionJson);

      expect(session!.messages).toEqual([]);
      expect(session!.parts).toBeInstanceOf(Map);
      expect(session!.parts.size).toBe(0);
    });
  });

  describe('extractSessionContext', () => {
    it('extracts session metadata', () => {
      const importer = createImporter();
      const sessionJson = loadFixture('session.json');
      const session = importer.parseRecord(sessionJson)!;
      const context = importer.extractSessionContext([session]);

      expect(context.adapterSessionId).toBe('ses_43d462e9cffexz6719QK96K7Ei');
      expect(context.cwd).toBe('/home/user/source-workspace/terminal');
      expect(context.model).toBeNull(); // Model is in messages, not session
    });

    it('emits session.discovered event', () => {
      const importer = createImporter();
      const sessionJson = loadFixture('session.json');
      const session = importer.parseRecord(sessionJson)!;
      const context = importer.extractSessionContext([session]);

      expect(context.sessionEvent.subject).toBe(AdapterSubjects.session.discovered);
      expect(context.sessionEvent.payload).toMatchObject({
        adapterSessionId: 'ses_43d462e9cffexz6719QK96K7Ei',
        parentAdapterSessionId: null,
        projectHash: '306ec0503454c53557861e73d40bcc85e6bf41be',
      });
    });

    it('carries the session start timestamp on session.discovered payloads', () => {
      const importer = createImporter();
      const sessionJson = loadFixture('session.json');
      const session = importer.parseRecord(sessionJson)!;
      const context = importer.extractSessionContext([session]);

      expect(context.sessionEvent.payload).toMatchObject({
        startedAt: 1768498516323,
      });
    });

    it('emits agent.started event', () => {
      const importer = createImporter();
      const sessionJson = loadFixture('session.json');
      const session = importer.parseRecord(sessionJson)!;
      const context = importer.extractSessionContext([session]);

      expect(context.startedEvent.subject).toBe(AgentSubjects.started);
      expect(context.startedEvent.payload).toMatchObject({
        agentId: 'main',
        adapterSessionId: 'ses_43d462e9cffexz6719QK96K7Ei',
        cwd: '/home/user/source-workspace/terminal',
      });
    });

    it('initializes import state', () => {
      const importer = createImporter();
      const sessionJson = loadFixture('session.json');
      const session = importer.parseRecord(sessionJson)!;
      const context = importer.extractSessionContext([session]);

      expect(context.state.lastProcessedIndex).toBe(0);
      expect(context.state.lastUserMessageId).toBeUndefined();
      expect(context.state.turnTrackerState).toBeDefined();
    });
  });

  describe('extractDiscoveryMetadata', () => {
    let sessionFilePath: string;

    beforeEach(() => {
      sessionFilePath = setupStorageFixtures(testStorageDir).sessionFilePath;
    });

    it('includes startedAt from the session metadata file', async () => {
      const importer = createImporter();

      const metadata = await importer.extractDiscoveryMetadata(sessionFilePath);

      expect(metadata.startedAt).toBe(1768498516323);
    });
  });

  describe('processRecords with real files', () => {
    let sessionFilePath: string;

    beforeEach(() => {
      sessionFilePath = setupStorageFixtures(testStorageDir).sessionFilePath;
    });

    it('loads messages and parts from disk', () => {
      const importer = createImporter();

      const sessionJson = loadFixture('session.json');
      const session = importer.parseRecord(sessionJson, sessionFilePath)!;
      const context = importer.extractSessionContext([session]);
      const events = importer.processRecords([session], context);

      // Should have events for both messages
      expect(events.length).toBeGreaterThan(0);

      // Check for user message
      const userMsgEvents = events.filter((e) => e.subject === AgentSubjects.user_message.sent);
      expect(userMsgEvents).toHaveLength(1);
      expect(userMsgEvents[0].payload).toMatchObject({
        messageId: 'msg_bb815fae3001NfwSfS3QMC3yzU',
        content: {
          role: 'user',
          blocks: [
            {
              type: 'text',
              content: 'Install the opencode-antigravity-auth plugin',
            },
          ],
        },
      });

      // Check for assistant message
      const assistantMsgEvents = events.filter((e) => e.subject === AgentSubjects.message);
      expect(assistantMsgEvents).toHaveLength(1);
      expect(assistantMsgEvents[0].payload).toMatchObject({
        messageId: 'msg_bbc7965ee0013MiAht130lgpXk',
        content: "I'll help you install the opencode-antigravity-auth plugin.",
      });

      // Check for tool use
      const toolUseEvents = events.filter((e) => e.subject === AgentSubjects.tool.use);
      expect(toolUseEvents).toHaveLength(1);
      expect(toolUseEvents[0].payload).toMatchObject({
        toolName: 'bash',
        toolCallId: 'call_d6SQnvFHmHk0blYcoQAToZb0',
      });

      // Check for tool completed
      const toolCompletedEvents = events.filter((e) => e.subject === AgentSubjects.tool.completed);
      expect(toolCompletedEvents).toHaveLength(1);
      expect(toolCompletedEvents[0].payload).toMatchObject({
        toolCallId: 'call_d6SQnvFHmHk0blYcoQAToZb0',
        output: 'package.json\nREADME.md\nsrc/',
      });

      // Check for usage metrics
      const usageEvents = events.filter((e) => e.subject === AgentSubjects.usage);
      expect(usageEvents).toHaveLength(1);
      expect(usageEvents[0].payload).toMatchObject({
        provider: 'openai',
        model: 'openai/gpt-5.2-chat-latest',
        inputTokens: 1500,
        // Legacy nested metrics format carries no cache/reasoning counts
        inputCachedTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 250,
        reasoningTokens: 0,
        totalTokens: 1750,
        // Token-counting adapter convention: cost units are tokens
        costUnits: 1750,
        costUnitType: 'tokens',
        cost: 0.0175,
        // One step-finish part = one LLM request in OpenCode
        granularity: 'provider-call',
        // Cost is read from the external tool's log, not from the provider
        costProvenance: 'client-reported',
      });

      // The payload must survive the strict bus emit path, which validates
      // against the registered agent.usage schema in dev mode.
      expect(() => AgentSchemas.usage.parse(usageEvents[0].payload)).not.toThrow();
    });

    it('maps cache and reasoning tokens from current-format step-finish parts', () => {
      // Current-format step-finish part with non-zero cache/reasoning counts
      writeFileSync(
        join(
          testStorageDir,
          'project',
          'test-slug',
          'storage',
          'part',
          'msg_bbc7965ee0013MiAht130lgpXk',
          'prt_bbc796e5a004StepFinishCache.json',
        ),
        JSON.stringify({
          id: 'prt_bbc796e5a004StepFinishCache',
          sessionID: 'ses_43d462e9cffexz6719QK96K7Ei',
          messageID: 'msg_bbc7965ee0013MiAht130lgpXk',
          type: 'step-finish',
          cost: 0.005,
          tokens: {
            input: 100,
            output: 50,
            reasoning: 25,
            cache: { read: 40, write: 12 },
          },
        }),
      );

      const importer = createImporter();
      const sessionJson = loadFixture('session.json');
      const session = importer.parseRecord(sessionJson, sessionFilePath)!;
      const context = importer.extractSessionContext([session]);
      const events = importer.processRecords([session], context);

      const usageEvents = events.filter((e) => e.subject === AgentSubjects.usage);
      const cacheEvent = usageEvents.find((e) => e.payload.inputTokens === 100);
      expect(cacheEvent).toBeDefined();
      expect(cacheEvent!.payload).toMatchObject({
        inputTokens: 100,
        inputCachedTokens: 40,
        cacheWriteTokens: 12,
        outputTokens: 50,
        reasoningTokens: 25,
        // Current format has no explicit total: input + output
        totalTokens: 150,
        costUnits: 150,
        costUnitType: 'tokens',
        cost: 0.005,
        costProvenance: 'client-reported',
      });

      // Every usage payload must pass the schema the bus validates against.
      for (const event of usageEvents) {
        expect(() => AgentSchemas.usage.parse(event.payload)).not.toThrow();
      }
    });

    it('omits costProvenance on usage events when the step-finish part has no cost', () => {
      // Additional step-finish part with tokens but without any cost data
      writeFileSync(
        join(
          testStorageDir,
          'project',
          'test-slug',
          'storage',
          'part',
          'msg_bbc7965ee0013MiAht130lgpXk',
          'prt_bbc796e5a003StepFinishNoCost.json',
        ),
        JSON.stringify({
          id: 'prt_bbc796e5a003StepFinishNoCost',
          sessionID: 'ses_43d462e9cffexz6719QK96K7Ei',
          messageID: 'msg_bbc7965ee0013MiAht130lgpXk',
          type: 'step-finish',
          tokens: { input: 10, output: 5 },
        }),
      );

      const importer = createImporter();
      const sessionJson = loadFixture('session.json');
      const session = importer.parseRecord(sessionJson, sessionFilePath)!;
      const context = importer.extractSessionContext([session]);
      const events = importer.processRecords([session], context);

      const usageEvents = events.filter((e) => e.subject === AgentSubjects.usage);
      expect(usageEvents).toHaveLength(2);

      // Every usage event truthfully declares per-request granularity
      for (const event of usageEvents) {
        expect(event.payload.granularity).toBe('provider-call');
      }

      const noCostEvent = usageEvents.find((e) => e.payload.inputTokens === 10);
      expect(noCostEvent).toBeDefined();
      expect(noCostEvent!.payload).not.toHaveProperty('cost');
      expect(noCostEvent!.payload).not.toHaveProperty('costProvenance');

      // Cost-less payloads must also pass strict bus schema validation.
      expect(() => AgentSchemas.usage.parse(noCostEvent!.payload)).not.toThrow();
    });

    it('tool events carry a defined turnId from the turn tracker', () => {
      const importer = createImporter();

      const sessionJson = loadFixture('session.json');
      const session = importer.parseRecord(sessionJson, sessionFilePath)!;
      const context = importer.extractSessionContext([session]);
      const events = importer.processRecords([session], context);

      // The user message starts a turn, and tool events from the assistant
      // response should carry that turn ID (not undefined).
      const toolUseEvents = events.filter((e) => e.subject === AgentSubjects.tool.use);
      expect(toolUseEvents).toHaveLength(1);
      expect(toolUseEvents[0].payload.turnId).toBeDefined();

      const toolCompletedEvents = events.filter((e) => e.subject === AgentSubjects.tool.completed);
      expect(toolCompletedEvents).toHaveLength(1);
      expect(toolCompletedEvents[0].payload.turnId).toBeDefined();

      // Both events belong to the same turn
      expect(toolUseEvents[0].payload.turnId).toBe(toolCompletedEvents[0].payload.turnId);
    });

    it('adds _import metadata to all events', () => {
      const importer = createImporter();

      const sessionJson = loadFixture('session.json');
      const session = importer.parseRecord(sessionJson, sessionFilePath)!;
      const context = importer.extractSessionContext([session]);
      const events = importer.processRecords([session], context);

      events.forEach((event) => {
        expect(event.payload).toHaveProperty('_import');
        expect(event.payload._import).toMatchObject({
          source: 'external',
          tool: 'plugin:opencode',
          streaming: false,
        });
      });
    });
  });

  describe('messagePayloads extraction', () => {
    let sessionFilePath: string;

    beforeEach(() => {
      sessionFilePath = setupStorageFixtures(testStorageDir).sessionFilePath;
      writeFileSync(
        join(
          testStorageDir,
          'project',
          'test-slug',
          'storage',
          'part',
          'msg_bbc7965ee0013MiAht130lgpXk',
          'prt_bbc7965ee003ReasoningXYZ.json',
        ),
        loadFixture('part-reasoning.json'),
      );
    });

    it('returns non-empty messagePayloads', () => {
      const importer = createImporter();
      const session = importer.parseRecord(loadFixture('session.json'), sessionFilePath)!;
      const result = importer.processLogFile(session);

      expect(result.messagePayloads.length).toBeGreaterThan(0);
    });

    it('user payload contentText is built from text parts', () => {
      const importer = createImporter();
      const session = importer.parseRecord(loadFixture('session.json'), sessionFilePath)!;
      const result = importer.processLogFile(session);

      const userPayload = result.messagePayloads.find((p) => p.role === 'user');
      expect(userPayload).toBeDefined();
      expect(userPayload!.contentText).toBe('Install the opencode-antigravity-auth plugin');
    });

    it('assistant payload includes text, reasoning, and tool blocks', () => {
      const importer = createImporter();
      const session = importer.parseRecord(loadFixture('session.json'), sessionFilePath)!;
      const result = importer.processLogFile(session);

      const assistantPayload = result.messagePayloads.find((p) => p.role === 'assistant');
      expect(assistantPayload).toBeDefined();

      const blockTypes = assistantPayload!.blocks.map((b) => b.type);
      expect(blockTypes).toContain('text');
      expect(blockTypes).toContain('reasoning');
      expect(blockTypes).toContain('tool_call');
      expect(blockTypes).toContain('tool_output');
    });

    it('agentId reflects message.agent value, not hardcoded main', () => {
      const importer = createImporter();
      const session = importer.parseRecord(loadFixture('session.json'), sessionFilePath)!;
      const result = importer.processLogFile(session);

      // Both fixture messages have agent: "build" (OpenCode multi-agent)
      for (const payload of result.messagePayloads) {
        expect(payload.agentId).toBe('build');
      }
    });

    it('all payloads have a valid adapterSessionId', () => {
      const importer = createImporter();
      const session = importer.parseRecord(loadFixture('session.json'), sessionFilePath)!;
      const result = importer.processLogFile(session);

      for (const payload of result.messagePayloads) {
        expect(payload.adapterSessionId).toBe('ses_43d462e9cffexz6719QK96K7Ei');
      }
    });

    it('all payloads have a numeric timestamp greater than 0', () => {
      const importer = createImporter();
      const session = importer.parseRecord(loadFixture('session.json'), sessionFilePath)!;
      const result = importer.processLogFile(session);

      for (const payload of result.messagePayloads) {
        expect(typeof payload.timestamp).toBe('number');
        expect(payload.timestamp).toBeGreaterThan(0);
      }
    });

    it('adapterMessageId matches the source message id', () => {
      const importer = createImporter();
      const session = importer.parseRecord(loadFixture('session.json'), sessionFilePath)!;
      const result = importer.processLogFile(session);

      const userPayload = result.messagePayloads.find((p) => p.role === 'user');
      const assistantPayload = result.messagePayloads.find((p) => p.role === 'assistant');

      expect(userPayload!.adapterMessageId).toBe('msg_bb815fae3001NfwSfS3QMC3yzU');
      expect(assistantPayload!.adapterMessageId).toBe('msg_bbc7965ee0013MiAht130lgpXk');
    });
  });

  describe('processLogFile input invariant', () => {
    it('accepts a single-record array', () => {
      const importer = createImporter();
      const session = importer.parseRecord(loadFixture('session.json'))!;
      const result = importer.processLogFile([session]);
      expect(result.adapterSessionId).toBe('ses_43d462e9cffexz6719QK96K7Ei');
    });

    it('throws when more than one session record is provided', () => {
      const importer = createImporter();
      const session = importer.parseRecord(loadFixture('session.json'))!;
      expect(() => importer.processLogFile([session, session])).toThrow(
        'OpenCodeLogImporter.processLogFile expects exactly 1 session record',
      );
    });
  });

  describe('serializeState and deserializeState', () => {
    it('round-trips state correctly', () => {
      const importer = createImporter();
      const sessionJson = loadFixture('session.json');
      const session = importer.parseRecord(sessionJson)!;
      const context = importer.extractSessionContext([session]);

      const serialized = importer.serializeState(context.state);
      const deserialized = importer.deserializeState(serialized);

      expect(deserialized).toEqual(context.state);
    });

    it('handles optional fields correctly', () => {
      const importer = createImporter();
      const sessionJson = loadFixture('session.json');
      const session = importer.parseRecord(sessionJson)!;
      const context = importer.extractSessionContext([session]);

      context.state.lastUserMessageId = 'msg_123';

      const serialized = importer.serializeState(context.state);
      const deserialized = importer.deserializeState(serialized);

      expect(deserialized.lastUserMessageId).toBe('msg_123');
    });
  });
});
