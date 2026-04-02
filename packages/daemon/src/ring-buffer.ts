/**
 * RingBuffer — fixed-capacity circular buffer for bounded event storage.
 *
 * When the buffer is full, the oldest entries are silently discarded.
 * Supports iteration and filtering while keeping memory usage constant.
 */
export class RingBuffer<T> {
  private readonly items: (T | undefined)[];
  private head = 0; // next write position
  private count = 0;
  readonly capacity: number;

  constructor(capacity: number) {
    if (capacity < 1) throw new Error("RingBuffer capacity must be >= 1");
    this.capacity = capacity;
    this.items = new Array<T | undefined>(capacity);
  }

  /** Number of elements currently stored. */
  get size(): number {
    return this.count;
  }

  /** Push a new element, evicting the oldest if at capacity. */
  push(item: T): void {
    this.items[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) {
      this.count++;
    }
  }

  /** Return all stored elements in insertion order (oldest first). */
  toArray(): T[] {
    if (this.count === 0) return [];
    const result: T[] = new Array(this.count);
    const start = this.count < this.capacity ? 0 : this.head;
    for (let i = 0; i < this.count; i++) {
      result[i] = this.items[(start + i) % this.capacity] as T;
    }
    return result;
  }

  /** Remove all elements. */
  clear(): void {
    this.items.fill(undefined);
    this.head = 0;
    this.count = 0;
  }
}
