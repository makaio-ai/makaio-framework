import pDefer from 'p-defer';

export class DeferredPromise<T> {
  private deferred = pDefer<T>();
  private isTracked = false;

  public getPromise(): Promise<T> {
    this.isTracked = true;
    return this.deferred.promise;
  }

  public resolve(value: T): void {
    this.deferred.resolve(value);
  }

  public reject(error: Error): void {
    if (this.isTracked) {
      this.deferred.reject(error);
    }
    // else: nobody is listening, silent discard
  }
}
