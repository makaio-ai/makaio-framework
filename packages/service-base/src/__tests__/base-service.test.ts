import { describe, it, expect, vi, afterEach } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import { BaseService } from '../base-service.js';

class InitFailureService extends BaseService {
  public readonly steps: string[] = [];

  public constructor() {
    super(createBusInstance());
  }

  protected override async onInit(): Promise<void> {
    this.addCleanup(() => {
      this.steps.push('cleanup-1');
    });
    this.addCleanup(async () => {
      await Promise.resolve();
      this.steps.push('cleanup-2');
      throw new Error('cleanup-2-failure');
    });
    throw new Error('init-failure');
  }
}

class DestroyFailureService extends BaseService {
  public readonly steps: string[] = [];

  public constructor() {
    super(createBusInstance());
  }

  protected override onInit(): void {
    this.addCleanup(() => {
      this.steps.push('cleanup-1');
      throw new Error('cleanup-1-failure');
    });
    this.addCleanup(() => {
      this.steps.push('cleanup-2');
    });
  }
}

class DestroyHookFailureService extends BaseService {
  public readonly steps: string[] = [];

  public constructor() {
    super(createBusInstance());
  }

  protected override onInit(): void {
    this.addCleanup(() => {
      this.steps.push('cleanup-1');
      throw new Error('cleanup-1-failure');
    });
    this.addCleanup(() => {
      this.steps.push('cleanup-2');
    });
  }

  protected override onDestroy(): void {
    this.steps.push('on-destroy');
    throw new Error('on-destroy-failure');
  }
}

class ReusableService extends BaseService {
  public readonly steps: string[] = [];

  public constructor() {
    super(createBusInstance());
  }

  protected override onInit(): void {
    this.addCleanup(() => {
      this.steps.push('cleanup');
    });
  }
}

class AsyncDestroyService extends BaseService {
  public readonly steps: string[] = [];
  private resolveCleanup?: () => void;
  public readonly cleanupCompleted = new Promise<void>((resolve) => {
    this.resolveCleanup = resolve;
  });

  public constructor() {
    super(createBusInstance());
  }

  protected override onInit(): void {
    this.addCleanup(async () => {
      this.steps.push('cleanup-start');
      await this.cleanupCompleted;
      this.steps.push('cleanup-finish');
    });
  }

  public finishCleanup(): void {
    this.resolveCleanup?.();
  }
}

class ConcurrentInitService extends BaseService {
  public readonly steps: string[] = [];
  public initCalls = 0;
  public cleanupCalls = 0;
  private resolveInit?: () => void;
  public readonly initStarted = new Promise<void>((resolve) => {
    this.resolveInit = resolve;
  });
  private readonly initReady = Promise.withResolvers<void>();

  public constructor() {
    super(createBusInstance());
  }

  protected override async onInit(): Promise<void> {
    this.initCalls += 1;
    this.steps.push('init-start');
    this.addCleanup(() => {
      this.cleanupCalls += 1;
      this.steps.push('cleanup');
    });
    this.resolveInit?.();
    await this.initReady.promise;
    this.steps.push('init-finish');
  }

  public finishInit(): void {
    this.initReady.resolve();
  }
}

class InitDestroyRaceService extends BaseService {
  public readonly steps: string[] = [];
  private resolveInit?: () => void;
  public readonly initStarted = new Promise<void>((resolve) => {
    this.resolveInit = resolve;
  });
  private readonly initReady = Promise.withResolvers<void>();

  public constructor() {
    super(createBusInstance());
  }

  protected override async onInit(): Promise<void> {
    this.steps.push('init-start');
    this.addCleanup(() => {
      this.steps.push('cleanup');
    });
    this.resolveInit?.();
    await this.initReady.promise;
    this.steps.push('init-finish');
  }

  protected override onDestroy(): void {
    this.steps.push('destroy');
  }

  public finishInit(): void {
    this.initReady.resolve();
  }
}

describe('BaseService lifecycle', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs already-registered cleanups when onInit throws and keeps initialized false', async () => {
    const service = new InitFailureService();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(service.init()).rejects.toThrow('init-failure');
    expect(service.initialized).toBe(false);
    expect(service.steps).toEqual(['cleanup-1', 'cleanup-2']);
    expect(consoleSpy).toHaveBeenCalled();
  });

  it('continues destroy cleanups after errors, resets initialized, and rejects', async () => {
    const service = new DestroyFailureService();
    await service.init();

    const rejection = await service.destroy().then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(service.steps).toEqual(['cleanup-1', 'cleanup-2']);
    expect(service.initialized).toBe(false);
    expect(rejection).toBeInstanceOf(AggregateError);
    expect((rejection as AggregateError).errors.map((error: Error) => error.message)).toEqual(['cleanup-1-failure']);
  });

  it('aggregates an onDestroy failure with cleanup failures after running every cleanup', async () => {
    const service = new DestroyHookFailureService();
    await service.init();

    const rejection = await service.destroy().then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(service.steps).toEqual(['on-destroy', 'cleanup-1', 'cleanup-2']);
    expect(rejection).toBeInstanceOf(AggregateError);
    expect((rejection as AggregateError).errors.map((error: Error) => error.message)).toEqual([
      'on-destroy-failure',
      'cleanup-1-failure',
    ]);
  });

  it('delivers the same teardown rejection to concurrent destroy callers', async () => {
    const service = new DestroyFailureService();
    await service.init();

    const first = service.destroy();
    const second = service.destroy();
    const [firstError, secondError] = await Promise.all([
      first.catch((error: unknown) => error),
      second.catch((error: unknown) => error),
    ]);

    expect(firstError).toBeInstanceOf(AggregateError);
    expect(secondError).toBe(firstError);
    expect(service.steps).toEqual(['cleanup-1', 'cleanup-2']);
  });

  it('rejects a retried teardown with the failure of the first instead of reporting it clean', async () => {
    const service = new DestroyFailureService();
    await service.init();

    const firstError = await service.destroy().catch((error: unknown) => error);
    const retryError = await service.destroy().catch((error: unknown) => error);

    expect(firstError).toBeInstanceOf(AggregateError);
    expect(retryError).toBe(firstError);
    // The retry shares the one teardown rather than re-running cleanups that
    // already released whatever they could.
    expect(service.steps).toEqual(['cleanup-1', 'cleanup-2']);
  });

  it('refuses to re-initialize a service whose teardown failed', async () => {
    const service = new DestroyFailureService();
    await service.init();
    const teardownError = await service.destroy().catch((error: unknown) => error);

    await expect(service.init()).rejects.toBe(teardownError);
    expect(service.initialized).toBe(false);
  });

  it('tears down again after a clean teardown and a fresh init', async () => {
    const service = new ReusableService();

    await service.init();
    await service.destroy();
    await service.init();
    await service.destroy();

    expect(service.steps).toEqual(['cleanup', 'cleanup']);
    expect(service.initialized).toBe(false);
  });

  it('awaits async destroy cleanups and stays idempotent while teardown is in flight', async () => {
    const service = new AsyncDestroyService();
    await service.init();

    const destroyPromise = service.destroy();
    await Promise.resolve();
    expect(service.steps).toEqual(['cleanup-start']);
    expect(service.initialized).toBe(false);

    const secondDestroyPromise = service.destroy();
    await Promise.resolve();
    expect(service.steps).toEqual(['cleanup-start']);

    service.finishCleanup();
    await expect(Promise.all([destroyPromise, secondDestroyPromise])).resolves.toEqual([undefined, undefined]);
    expect(service.steps).toEqual(['cleanup-start', 'cleanup-finish']);
  });

  it('waits for in-flight destroy before allowing re-init', async () => {
    const service = new AsyncDestroyService();
    await service.init();

    const destroyPromise = service.destroy();
    const reinitPromise = service.init();
    await Promise.resolve();
    await Promise.resolve();

    expect(service.steps).toEqual(['cleanup-start']);

    service.finishCleanup();
    await destroyPromise;
    await expect(reinitPromise).resolves.toBeUndefined();
    expect(service.initialized).toBe(true);
  });

  it('shares one in-flight init across concurrent callers', async () => {
    const service = new ConcurrentInitService();

    const firstInitPromise = service.init();
    const secondInitPromise = service.init();
    await service.initStarted;

    expect(service.initCalls).toBe(1);
    expect(service.steps).toEqual(['init-start']);

    service.finishInit();
    await expect(Promise.all([firstInitPromise, secondInitPromise])).resolves.toEqual([undefined, undefined]);

    expect(service.initialized).toBe(true);
    expect(service.steps).toEqual(['init-start', 'init-finish']);

    await service.destroy();
    expect(service.cleanupCalls).toBe(1);
    expect(service.steps).toEqual(['init-start', 'init-finish', 'cleanup']);
  });

  it('waits for in-flight init before destroying and does not stay initialized afterward', async () => {
    const service = new InitDestroyRaceService();

    const initPromise = service.init();
    await service.initStarted;

    const destroyPromise = service.destroy();
    await Promise.resolve();

    expect(service.steps).toEqual(['init-start']);
    expect(service.initialized).toBe(false);

    service.finishInit();
    await expect(initPromise).resolves.toBeUndefined();
    await expect(destroyPromise).resolves.toBeUndefined();

    expect(service.steps).toEqual(['init-start', 'init-finish', 'destroy', 'cleanup']);
    expect(service.initialized).toBe(false);
  });
});
