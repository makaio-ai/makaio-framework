/**
 * Tests for {@link installExtensionPackages}.
 *
 * Uses a mock bus to verify that the wrapper correctly delegates to the
 * package manager install subject, maps responses to `InstallProgress`
 * entries, and throws on failure.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { createMockBus, createTestBusInstance, type MockBusResult } from '@makaio/test-utils';
import { PackageSubjects } from '@makaio/services-package-manager';
import { installExtensionPackages } from '../bus/package-manager-ops.js';

describe('installExtensionPackages', () => {
  let mockBus: MockBusResult;

  beforeEach(() => {
    mockBus = createMockBus();
  });

  it('returns an empty array when no packages are provided', async () => {
    const result = await installExtensionPackages(mockBus.bus, []);

    expect(result).toEqual([]);
    expect(mockBus.request).not.toHaveBeenCalled();
  });

  it('calls bus.request for each package with the correct subject', async () => {
    mockBus.request.mockResolvedValue({
      success: true,
      packageName: 'pkg-a',
      restartRequired: false,
    });

    await installExtensionPackages(mockBus.bus, ['pkg-a', 'pkg-b']);

    expect(mockBus.request).toHaveBeenCalledTimes(2);
    expect(mockBus.request).toHaveBeenNthCalledWith(1, PackageSubjects.install, {
      packageNames: ['pkg-a'],
      source: 'npm',
    });
    expect(mockBus.request).toHaveBeenNthCalledWith(2, PackageSubjects.install, {
      packageNames: ['pkg-b'],
      source: 'npm',
    });
  });

  it('maps successful responses to InstallProgress entries', async () => {
    mockBus.request
      .mockResolvedValueOnce({
        success: true,
        packageName: 'pkg-a',
        restartRequired: false,
      })
      .mockResolvedValueOnce({
        success: true,
        packageName: 'pkg-b',
        restartRequired: true,
      });

    const result = await installExtensionPackages(mockBus.bus, ['pkg-a', 'pkg-b']);

    expect(result).toEqual([
      { packageName: 'pkg-a', success: true, restartRequired: false, error: undefined },
      { packageName: 'pkg-b', success: true, restartRequired: true, error: undefined },
    ]);
  });

  it('includes the error message in the InstallProgress entry on failure', async () => {
    mockBus.request.mockResolvedValueOnce({
      success: false,
      packageName: 'pkg-fail',
      restartRequired: false,
      error: 'package not found',
    });

    await expect(installExtensionPackages(mockBus.bus, ['pkg-fail'])).rejects.toThrow(
      'Failed to install pkg-fail: package not found',
    );
  });

  it('throws with "unknown error" when response error field is absent', async () => {
    mockBus.request.mockResolvedValueOnce({
      success: false,
      packageName: 'pkg-fail',
      restartRequired: false,
    });

    await expect(installExtensionPackages(mockBus.bus, ['pkg-fail'])).rejects.toThrow(
      'Failed to install pkg-fail: unknown error',
    );
  });

  it('stops installing remaining packages after a failure', async () => {
    mockBus.request
      .mockResolvedValueOnce({
        success: true,
        packageName: 'pkg-a',
        restartRequired: false,
      })
      .mockResolvedValueOnce({
        success: false,
        packageName: 'pkg-b',
        restartRequired: false,
        error: 'download failed',
      });

    await expect(installExtensionPackages(mockBus.bus, ['pkg-a', 'pkg-b', 'pkg-c'])).rejects.toThrow(
      'Failed to install pkg-b: download failed',
    );

    // pkg-c must not have been attempted
    expect(mockBus.request).toHaveBeenCalledTimes(2);
  });

  it('exercises package install requests through real bus handlers', async () => {
    const bus = createTestBusInstance();
    const installed: string[] = [];
    const unsubscribe = bus.on(PackageSubjects.install, (ctx) => {
      const packageName = (ctx.payload.packageNames ?? [])[0];
      if (packageName === undefined) {
        throw new Error('Expected setup package install request to include one package name');
      }
      installed.push(packageName);
      ctx.setResult({
        success: true,
        packageName,
        restartRequired: packageName === 'pkg-b',
      });
    });

    const result = await installExtensionPackages(bus, ['pkg-a', 'pkg-b']);

    expect(installed).toEqual(['pkg-a', 'pkg-b']);
    expect(result).toEqual([
      { packageName: 'pkg-a', success: true, restartRequired: false, error: undefined },
      { packageName: 'pkg-b', success: true, restartRequired: true, error: undefined },
    ]);
    unsubscribe();
  });
});
