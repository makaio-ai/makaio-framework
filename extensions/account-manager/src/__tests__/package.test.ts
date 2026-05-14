import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { MakaioBus, type IMakaioBus } from '@makaio/bus-core';
import { BaseService } from '@makaio/service-base';
import { ExtensionDescriptorSchema, type NodeExtensionContext as ExtensionContext } from '@makaio/contracts';
import { accountManagerPackage } from '../package.js';
import { AccountManager } from '../account-manager.js';
import { hasEnabledAutoActivationSource } from '../account-manager-types.js';
import type { AutoActivationConfig } from '../account-manager-types.js';

const baseCtx: Omit<ExtensionContext<IMakaioBus>, 'platform'> = {
  bus: MakaioBus,
  identity: Object.freeze({ extensionName: 'account-manager' }) as ExtensionContext<IMakaioBus>['identity'],
  homedir: '/tmp/test-home',
  makaioHome: path.join('/tmp/test-home', '.makaio'),
  dataDir: path.join('/tmp/test-home', '.makaio', 'account-manager'),
  username: 'testuser',
  machineId: 'test-machine-id',
  config: { makaioCommand: 'makaio-test' },
  getService: () => undefined,
  tryImport: async (_specifier) => null,
  signal: new AbortController().signal,
  hasExtension: (_name) => false,
};

describe('accountManagerPackage', () => {
  it('has correct name and displayName', () => {
    expect(accountManagerPackage.name).toBe('account-manager');
    expect(accountManagerPackage.displayName).toBe('Makaio Account Manager');
  });

  it('create returns an AccountManager instance on linux', () => {
    const service = accountManagerPackage.create!({ ...baseCtx, platform: 'linux' });
    expect(service).toBeInstanceOf(AccountManager);
    expect(service).toBeInstanceOf(BaseService);
  });

  it('create returns an AccountManager instance on darwin', () => {
    const service = accountManagerPackage.create!({ ...baseCtx, platform: 'darwin' });
    expect(service).toBeInstanceOf(AccountManager);
    expect(service).toBeInstanceOf(BaseService);
  });

  it('create returns an AccountManager instance on win32', () => {
    const service = accountManagerPackage.create!({ ...baseCtx, platform: 'win32' });
    expect(service).toBeInstanceOf(AccountManager);
    expect(service).toBeInstanceOf(BaseService);
  });

  it('exposes CLI contribution with expected name', () => {
    expect(accountManagerPackage.cli).toBeDefined();
    expect(accountManagerPackage.cli?.name).toBe('account-manager');
  });

  it('declares a browser entrypoint while leaving tray and window ownership to the framework', () => {
    expect(accountManagerPackage.browser).toBeDefined();
    expect(accountManagerPackage.browser?.entrypoint).toBe('/extensions/account-manager/browser/index.js');
    expect(accountManagerPackage.windows).toBeUndefined();
    expect(accountManagerPackage.tray).toBeUndefined();
  });

  it('declares host-overridable account-manager configuration', () => {
    expect(accountManagerPackage.configSchema?.parse({ makaioCommand: 'host-cli' })).toEqual({
      makaioCommand: 'host-cli',
      autoActivation: { sources: {}, systemPrompt: 'Reply concisely.', message: 'ok' },
    });
    expect(accountManagerPackage.configSchema?.safeParse({}).success).toBe(false);
    expect(
      accountManagerPackage.configSchema?.safeParse({
        makaioCommand: 'host-cli',
        autoActivation: { message: ' ', systemPrompt: 'Reply concisely.' },
      }).success,
    ).toBe(false);
    expect(
      accountManagerPackage.configSchema?.safeParse({
        makaioCommand: 'host-cli',
        autoActivation: { message: 'ok', systemPrompt: '' },
      }).success,
    ).toBe(false);
  });

  it('declares descriptor defaults that satisfy required account-manager configuration', () => {
    const descriptorPath = fileURLToPath(new URL('../../descriptor.json', import.meta.url));
    const descriptor = ExtensionDescriptorSchema.parse(JSON.parse(fs.readFileSync(descriptorPath, 'utf-8')));

    expect(descriptor.config?.defaults).toEqual({ makaioCommand: 'makaio' });
    expect(accountManagerPackage.configSchema?.parse(descriptor.config?.defaults)).toEqual({
      makaioCommand: 'makaio',
      autoActivation: { sources: {}, systemPrompt: 'Reply concisely.', message: 'ok' },
    });
  });

  it('treats auto-activation as enabled only when a source opts in', () => {
    const disabledConfig: AutoActivationConfig = {
      sources: new Map([
        ['claude-code', { enabled: false }],
        ['codex', { enabled: false }],
      ]),
      systemPrompt: 'Reply concisely.',
      message: 'ok',
    };
    const enabledConfig: AutoActivationConfig = {
      sources: new Map([
        ['claude-code', { enabled: false }],
        ['codex', { enabled: true }],
      ]),
      systemPrompt: 'Reply concisely.',
      message: 'ok',
    };

    expect(hasEnabledAutoActivationSource(undefined)).toBe(false);
    expect(hasEnabledAutoActivationSource({ ...disabledConfig, sources: new Map() })).toBe(false);
    expect(hasEnabledAutoActivationSource(disabledConfig)).toBe(false);
    expect(hasEnabledAutoActivationSource(enabledConfig)).toBe(true);
  });
});
