/**
 * Tests for the setup TUI components and entry point.
 *
 * Uses `ink-testing-library` to render Ink components in a node environment
 * and assert on the terminal output strings. All JSX is written as
 * `React.createElement` calls so the file can run in the `unit` (node) test
 * project without triggering the `ui-jsdom` environment.
 *
 * `ink-testing-library` v3 was written for ink v4. Ink v6 changed the stdin API
 * from `'data'` events to `'readable'` events with `.read()`. The shim in
 * `test-helpers.ts` adds `ref()`/`unref()` no-op stubs to
 * `EventEmitter.prototype` so that `useInput`-based components can be rendered.
 * Full keyboard interaction tests are deferred to integration-level testing.
 */

import { afterEach, describe, expect, it } from 'vitest';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { ConsentStep } from './consent-step.js';
import { DetectStep } from './detect-step.js';
import { ManifestStep } from './manifest-step.js';
import { runSetupTui } from './app.js';
// Importing test-helpers also installs the EventEmitter ref/unref shim for
// ink v6 / ink-testing-library v3 compatibility.
import { makeState, makeClient } from './test-helpers.js';

// ---------------------------------------------------------------------------
// ConsentStep
// ---------------------------------------------------------------------------

describe('ConsentStep', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the terms version heading', () => {
    const state = makeState();
    const { lastFrame } = render(
      React.createElement(ConsentStep, {
        state,
        onAccept: () => undefined,
      }),
    );
    const output = lastFrame() ?? '';
    expect(output).toContain('v1.0');
  });

  it('renders the terms text', () => {
    const state = makeState({ termsText: 'Do not misuse.' });
    const { lastFrame } = render(
      React.createElement(ConsentStep, {
        state,
        onAccept: () => undefined,
      }),
    );
    const output = lastFrame() ?? '';
    expect(output).toContain('Do not misuse.');
  });

  it('renders the accept prompt', () => {
    const state = makeState();
    const { lastFrame } = render(
      React.createElement(ConsentStep, {
        state,
        onAccept: () => undefined,
      }),
    );
    const output = lastFrame() ?? '';
    expect(output).toContain('Press y to accept terms');
  });
});

// ---------------------------------------------------------------------------
// DetectStep
// ---------------------------------------------------------------------------

describe('DetectStep', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the heading', () => {
    const state = makeState({
      step: 'detect',
      detectedClients: [],
      selectedClientIds: [],
    });
    const { lastFrame } = render(
      React.createElement(DetectStep, {
        state,
        onSelectionChange: () => undefined,
        onInstall: () => undefined,
      }),
    );
    const output = lastFrame() ?? '';
    expect(output).toContain('Detected AI Clients');
  });

  it('renders navigation hint', () => {
    const state = makeState({ step: 'detect' });
    const { lastFrame } = render(
      React.createElement(DetectStep, {
        state,
        onSelectionChange: () => undefined,
        onInstall: () => undefined,
      }),
    );
    const output = lastFrame() ?? '';
    expect(output).toContain('Space');
    expect(output).toContain('Enter');
  });

  it('renders each client display name', () => {
    const state = makeState({
      step: 'detect',
      detectedClients: [makeClient('claude-code', 'Claude Code'), makeClient('gemini', 'Gemini')],
    });
    const { lastFrame } = render(
      React.createElement(DetectStep, {
        state,
        onSelectionChange: () => undefined,
        onInstall: () => undefined,
      }),
    );
    const output = lastFrame() ?? '';
    expect(output).toContain('Claude Code');
    expect(output).toContain('Gemini');
  });

  it('marks selected clients with [x]', () => {
    const state = makeState({
      step: 'detect',
      detectedClients: [makeClient('claude-code', 'Claude Code')],
      selectedClientIds: ['claude-code'],
    });
    const { lastFrame } = render(
      React.createElement(DetectStep, {
        state,
        onSelectionChange: () => undefined,
        onInstall: () => undefined,
      }),
    );
    const output = lastFrame() ?? '';
    expect(output).toContain('[x]');
  });

  it('marks unselected clients with [ ]', () => {
    const state = makeState({
      step: 'detect',
      detectedClients: [makeClient('claude-code', 'Claude Code')],
      selectedClientIds: [],
    });
    const { lastFrame } = render(
      React.createElement(DetectStep, {
        state,
        onSelectionChange: () => undefined,
        onInstall: () => undefined,
      }),
    );
    const output = lastFrame() ?? '';
    expect(output).toContain('[ ]');
  });

  it('appends "(not found)" for undetected clients', () => {
    const state = makeState({
      step: 'detect',
      detectedClients: [makeClient('ghost', 'Ghost Client', false)],
    });
    const { lastFrame } = render(
      React.createElement(DetectStep, {
        state,
        onSelectionChange: () => undefined,
        onInstall: () => undefined,
      }),
    );
    const output = lastFrame() ?? '';
    expect(output).toContain('(not found)');
  });

  it('shows the selected client count', () => {
    const state = makeState({
      step: 'detect',
      detectedClients: [makeClient('a', 'A'), makeClient('b', 'B')],
      selectedClientIds: ['a'],
    });
    const { lastFrame } = render(
      React.createElement(DetectStep, {
        state,
        onSelectionChange: () => undefined,
        onInstall: () => undefined,
      }),
    );
    const output = lastFrame() ?? '';
    expect(output).toContain('1 client(s) selected');
  });
});

describe('ManifestStep', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the heading and navigation help', () => {
    const state = makeState({
      step: 'manifest',
      manifestExtensionSpecs: ['@makaio/extension-workflow@0.1.0'],
      selectedManifestExtensionSpecs: ['@makaio/extension-workflow@0.1.0'],
    });

    const { lastFrame } = render(
      React.createElement(ManifestStep, {
        state,
        onSelectionChange: () => undefined,
        onInstall: () => undefined,
      }),
    );

    const output = lastFrame() ?? '';
    expect(output).toContain('Project Extensions');
    expect(output).toContain('Press number to toggle');
    expect(output).toContain('Enter to install');
  });

  it('renders multiple specs and marks selected versus unselected entries', () => {
    const state = makeState({
      step: 'manifest',
      manifestExtensionSpecs: ['@makaio/extension-workflow@0.1.0', '@makaio/extension-tasks@0.2.0'],
      selectedManifestExtensionSpecs: ['@makaio/extension-workflow@0.1.0'],
    });

    const { lastFrame } = render(
      React.createElement(ManifestStep, {
        state,
        onSelectionChange: () => undefined,
        onInstall: () => undefined,
      }),
    );

    const output = lastFrame() ?? '';
    expect(output).toContain('x 1. @makaio/extension-workflow@0.1.0');
    expect(output).toContain('  2. @makaio/extension-tasks@0.2.0');
  });

  it('does not render mismatch text when manifest specs have no mismatches', () => {
    const state = makeState({
      step: 'manifest',
      manifestExtensionSpecs: ['@makaio/extension-workflow@0.1.0'],
      selectedManifestExtensionSpecs: ['@makaio/extension-workflow@0.1.0'],
      manifestExtensionMismatches: [],
    });

    const { lastFrame } = render(
      React.createElement(ManifestStep, {
        state,
        onSelectionChange: () => undefined,
        onInstall: () => undefined,
      }),
    );

    const output = lastFrame() ?? '';
    expect(output).not.toContain('installed');
    expect(output).not.toContain('project requires');
  });

  it('renders manifest version mismatches', () => {
    const state = makeState({
      step: 'manifest',
      manifestExtensionSpecs: ['@makaio/extension-workflow@0.1.0'],
      selectedManifestExtensionSpecs: ['@makaio/extension-workflow@0.1.0'],
      manifestExtensionMismatches: [
        {
          manifest: {
            packageName: '@makaio/extension-workflow',
            version: '0.1.0',
            spec: '@makaio/extension-workflow@0.1.0',
          },
          installedVersion: '0.2.0',
        },
      ],
    });

    const { lastFrame } = render(
      React.createElement(ManifestStep, {
        state,
        onSelectionChange: () => undefined,
        onInstall: () => undefined,
      }),
    );

    const output = lastFrame() ?? '';
    expect(output).toContain('@makaio/extension-workflow@0.1.0');
    expect(output).toContain('installed 0.2.0, project requires 0.1.0');
  });
});

// ---------------------------------------------------------------------------
// runSetupTui export
// ---------------------------------------------------------------------------

describe('runSetupTui export', () => {
  it('exports runSetupTui as a function', () => {
    expect(typeof runSetupTui).toBe('function');
  });
});
