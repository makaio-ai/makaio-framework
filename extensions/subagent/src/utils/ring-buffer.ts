/**
 * Simple ring buffer with fixed maximum size.
 * When full, oldest items are dropped to make room for new ones.
 * @typeParam T - Type of items stored in the buffer
 */
export class RingBuffer<T> {
  private items: T[] = [];

  /**
   * Creates a new RingBuffer.
   * @param maxSize - Maximum number of items to store (default: 50)
   */
  public constructor(private readonly maxSize: number = 50) {}

  /**
   * Add an item to the buffer.
   * If at capacity, the oldest item is dropped.
   * @param item - Item to add
   */
  public push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.maxSize) {
      this.items.shift();
    }
  }

  /**
   * Get all items as an array (oldest first).
   * @returns Copy of the internal array
   */
  public toArray(): T[] {
    return [...this.items];
  }

  /**
   * Current number of items in the buffer.
   * @returns Number of items currently stored
   */
  public get length(): number {
    return this.items.length;
  }

  /**
   * Remove all items from the buffer.
   */
  public clear(): void {
    this.items = [];
  }
}
