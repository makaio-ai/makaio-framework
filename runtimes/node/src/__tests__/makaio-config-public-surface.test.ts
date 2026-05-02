import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  MAKAIO_CONFIG_FILE_ENV as RootMakaioConfigFileEnv,
  MAKAIO_HOME_ENV as RootMakaioHomeEnv,
  buildConfiguredRuntimeOptions as rootBuildConfiguredRuntimeOptions,
  createMakaioConfigDiscovery as rootCreateMakaioConfigDiscovery,
  defineMakaioConfig as rootDefineMakaioConfig,
  loadMakaioConfig as rootLoadMakaioConfig,
  parseMakaioConfig as rootParseMakaioConfig,
  resolveMakaioHome as rootResolveMakaioHome,
  resolveMakaioConfigPath as rootResolveMakaioConfigPath,
  type ConfiguredRuntimeOptions as RootConfiguredRuntimeOptions,
  type LoadedMakaioConfig as RootLoadedMakaioConfig,
  type LoadMakaioConfigOptions as RootLoadMakaioConfigOptions,
  type MakaioConfig as RootMakaioConfig,
  type ParsedMakaioConfig as RootParsedMakaioConfig,
  type ParseMakaioConfigOptions as RootParseMakaioConfigOptions,
} from '@makaio/runtime-node';
import {
  MAKAIO_CONFIG_FILE_ENV as SubpathMakaioConfigFileEnv,
  MAKAIO_HOME_ENV as SubpathMakaioHomeEnv,
  buildConfiguredRuntimeOptions as subpathBuildConfiguredRuntimeOptions,
  createMakaioConfigDiscovery as subpathCreateMakaioConfigDiscovery,
  defineMakaioConfig as subpathDefineMakaioConfig,
  loadMakaioConfig as subpathLoadMakaioConfig,
  parseMakaioConfig as subpathParseMakaioConfig,
  resolveMakaioHome as subpathResolveMakaioHome,
  resolveMakaioConfigPath as subpathResolveMakaioConfigPath,
  type ConfiguredRuntimeOptions as SubpathConfiguredRuntimeOptions,
  type LoadedMakaioConfig as SubpathLoadedMakaioConfig,
  type LoadMakaioConfigOptions as SubpathLoadMakaioConfigOptions,
  type MakaioConfig as SubpathMakaioConfig,
  type ParsedMakaioConfig as SubpathParsedMakaioConfig,
  type ParseMakaioConfigOptions as SubpathParseMakaioConfigOptions,
} from '@makaio/runtime-node/makaio-config';

describe('makaio config public surface', () => {
  it('exposes the same runtime helpers from the root and subpath entrypoints', () => {
    expect(SubpathMakaioConfigFileEnv).toBe(RootMakaioConfigFileEnv);
    expect(SubpathMakaioHomeEnv).toBe(RootMakaioHomeEnv);
    expect(subpathBuildConfiguredRuntimeOptions).toBe(rootBuildConfiguredRuntimeOptions);
    expect(subpathCreateMakaioConfigDiscovery).toBe(rootCreateMakaioConfigDiscovery);
    expect(subpathDefineMakaioConfig).toBe(rootDefineMakaioConfig);
    expect(subpathLoadMakaioConfig).toBe(rootLoadMakaioConfig);
    expect(subpathParseMakaioConfig).toBe(rootParseMakaioConfig);
    expect(subpathResolveMakaioHome).toBe(rootResolveMakaioHome);
    expect(subpathResolveMakaioConfigPath).toBe(rootResolveMakaioConfigPath);
  });

  it('exposes coherent config types from the root and subpath entrypoints', () => {
    expectTypeOf<SubpathConfiguredRuntimeOptions>().toEqualTypeOf<RootConfiguredRuntimeOptions>();
    expectTypeOf<SubpathLoadedMakaioConfig>().toEqualTypeOf<RootLoadedMakaioConfig>();
    expectTypeOf<SubpathLoadMakaioConfigOptions>().toEqualTypeOf<RootLoadMakaioConfigOptions>();
    expectTypeOf<SubpathMakaioConfig>().toEqualTypeOf<RootMakaioConfig>();
    expectTypeOf<SubpathParsedMakaioConfig>().toEqualTypeOf<RootParsedMakaioConfig>();
    expectTypeOf<SubpathParseMakaioConfigOptions>().toEqualTypeOf<RootParseMakaioConfigOptions>();
  });

  it('keeps host capabilities out of the config authoring and parsed surfaces', () => {
    expectTypeOf<SubpathConfiguredRuntimeOptions>().not.toHaveProperty('hostCapabilities');
    expectTypeOf<SubpathMakaioConfig>().not.toHaveProperty('hostCapabilities');
    expectTypeOf<SubpathParsedMakaioConfig>().not.toHaveProperty('hostCapabilities');
  });
});
