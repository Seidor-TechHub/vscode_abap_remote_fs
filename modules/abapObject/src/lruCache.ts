/**
 * Simple LRU (Least Recently Used) Cache implementation
 * Prevents unbounded memory growth by limiting cache size
 */
export class LRUCache<K, V> {
    private cache = new Map<K, V>()

    constructor(private readonly maxSize: number = 500) { }

    get(key: K): V | undefined {
        const value = this.cache.get(key)
        if (value !== undefined) {
            // Move to end (most recently used)
            this.cache.delete(key)
            this.cache.set(key, value)
        }
        return value
    }

    set(key: K, value: V): void {
        if (this.cache.has(key)) {
            this.cache.delete(key)
        } else if (this.cache.size >= this.maxSize) {
            // Delete oldest entry (first item in Map)
            const firstKey = this.cache.keys().next().value
            if (firstKey !== undefined) {
                this.cache.delete(firstKey)
            }
        }
        this.cache.set(key, value)
    }

    has(key: K): boolean {
        return this.cache.has(key)
    }

    delete(key: K): boolean {
        return this.cache.delete(key)
    }

    clear(): void {
        this.cache.clear()
    }

    get size(): number {
        return this.cache.size
    }
}
