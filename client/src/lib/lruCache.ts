/**
 * Simple LRU (Least Recently Used) Cache implementation
 * Prevents unbounded memory growth by limiting cache size
 */
export class LRUCache<K, V> {
    private cache = new Map<K, V>()
    private readonly maxSize: number

    constructor(maxSize: number = 500) {
        this.maxSize = maxSize
    }

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
        // Delete existing key to update its position
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

    *[Symbol.iterator](): IterableIterator<[K, V]> {
        yield* this.cache
    }

    keys(): IterableIterator<K> {
        return this.cache.keys()
    }

    values(): IterableIterator<V> {
        return this.cache.values()
    }

    entries(): IterableIterator<[K, V]> {
        return this.cache.entries()
    }
}

/**
 * LRU Cache with async value generation
 * Caches promise results and handles concurrent requests for same key
 */
export class AsyncLRUCache<K, V> {
    private cache: LRUCache<K, V>
    private pending = new Map<K, Promise<V>>()

    constructor(maxSize: number = 500) {
        this.cache = new LRUCache<K, V>(maxSize)
    }

    async get(key: K, factory: () => Promise<V>, refresh = false): Promise<V> {
        // Return cached value if available and not refreshing
        if (!refresh) {
            const cached = this.cache.get(key)
            if (cached !== undefined) {
                return cached
            }
        }

        // Return pending promise if already loading
        const pendingPromise = this.pending.get(key)
        if (pendingPromise && !refresh) {
            return pendingPromise
        }

        // Create new promise and cache it
        const promise = factory().then(value => {
            this.cache.set(key, value)
            this.pending.delete(key)
            return value
        }).catch(err => {
            this.pending.delete(key)
            throw err
        })

        this.pending.set(key, promise)
        return promise
    }

    getSync(key: K): V | undefined {
        return this.cache.get(key)
    }

    has(key: K): boolean {
        return this.cache.has(key)
    }

    delete(key: K): boolean {
        this.pending.delete(key)
        return this.cache.delete(key)
    }

    clear(): void {
        this.pending.clear()
        this.cache.clear()
    }

    get size(): number {
        return this.cache.size
    }
}
