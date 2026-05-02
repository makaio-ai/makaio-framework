/**
 * Source for feeding messages into AsyncIterable
 */
export class AsyncQuerySource<T> {
  private queue: T[] = [];
  private resolvers: Array<(value: IteratorResult<T>) => void> = [];
  private done = false;

  public async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
      } else if (this.done) {
        return;
      } else {
        yield await new Promise<T>((resolve) => {
          this.resolvers.push((result) => {
            if (!result.done) resolve(result.value);
          });
        });
      }
    }
  }

  public push(value: T): void {
    if (this.done) throw new Error('Cannot push to completed source');

    if (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift()!;
      resolve({ value, done: false });
    } else {
      this.queue.push(value);
    }
  }

  public complete(): void {
    this.done = true;
    for (const resolve of this.resolvers) {
      resolve({ value: undefined, done: true });
    }
    this.resolvers = [];
  }

  public clear(): void {
    this.queue = [];
  }
}
