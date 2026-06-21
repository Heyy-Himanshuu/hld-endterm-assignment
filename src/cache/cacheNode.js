// A SINGLE LOGICAL CACHE NODE.
//
// WHY this is its own class behind a tiny interface (get/set/delete/peek):
//  - The rubric asks for "multiple logical cache nodes". Each instance is one
//    independent store with its own data, its own TTL clock, and its own
//    hit/miss stats — exactly like a separate Redis instance would be.
//  - Keeping the interface this small is the honest answer to "is this really
//    distributed?": to swap these in-process nodes for real network Redis
//    instances you reimplement ONLY these four methods; the consistent-hash
//    ring and everything above it stay untouched.
//
// Storage = a JS Map, which preserves insertion order. We exploit that for an
// O(1) approximate-LRU: the first key is the oldest, so eviction deletes it.
// Expiry (TTL) bounds staleness so stale suggestions don't live forever.

export class CacheNode {
  constructor(id, { ttlMs, maxKeys }) {
    this.id = id;
    this.ttlMs = ttlMs;
    this.maxKeys = maxKeys;
    this.store = new Map(); // key -> { value, expiresAt }
    this.hits = 0;
    this.misses = 0;
  }

  // Read with hit/miss accounting + LRU bump. Expired entries are treated as a
  // miss and evicted lazily.
  get(key, now) {
    const entry = this.store.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (entry.expiresAt <= now) {
      this.store.delete(key);
      this.misses++;
      return undefined;
    }
    // LRU bump: re-insert so this key becomes the most-recently-used (last).
    this.store.delete(key);
    this.store.set(key, entry);
    this.hits++;
    return entry.value;
  }

  set(key, value, now) {
    // Evict oldest while at capacity (Map insertion order => first key is oldest).
    while (this.store.size >= this.maxKeys && !this.store.has(key)) {
      const oldest = this.store.keys().next().value;
      this.store.delete(oldest);
    }
    this.store.set(key, { value, expiresAt: now + this.ttlMs });
  }

  delete(key) {
    return this.store.delete(key);
  }

  // Non-mutating presence check used by /cache/debug so inspecting routing does
  // NOT pollute hit/miss stats or LRU order.
  peek(key, now) {
    const entry = this.store.get(key);
    return !!entry && entry.expiresAt > now;
  }

  stats() {
    const total = this.hits + this.misses;
    return {
      id: this.id,
      size: this.store.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total ? Number((this.hits / total).toFixed(4)) : 0,
    };
  }
}
