import { ConsistentHashRing } from './consistentHash.js';
import { CacheNode } from './cacheNode.js';

// THE DISTRIBUTED CACHE FACADE.
//
// Ties the consistent-hash ring to N logical CacheNodes. Callers use get/set/
// invalidate with a key and never need to know which node holds it — the ring
// decides. This is the layer the suggestion flow talks to.

export class DistributedCache {
  constructor({ nodeCount, virtualNodes, ttlMs, maxKeysPerNode }) {
    this.nodes = new Map();
    const ids = [];
    for (let i = 0; i < nodeCount; i++) {
      const id = `cache-node-${i}`;
      ids.push(id);
      this.nodes.set(id, new CacheNode(id, { ttlMs, maxKeys: maxKeysPerNode }));
    }
    this.ring = new ConsistentHashRing(ids, virtualNodes);
  }

  _nodeFor(key) {
    return this.nodes.get(this.ring.nodeFor(key));
  }

  get(key, now) {
    return this._nodeFor(key).get(key, now);
  }

  set(key, value, now) {
    this._nodeFor(key).set(key, value, now);
  }

  // Drop a single key from whichever node owns it (used by targeted
  // invalidation when a query's count/rank changes).
  invalidate(key) {
    return this._nodeFor(key).delete(key);
  }

  // Inspect routing for a key WITHOUT mutating stats — backs GET /cache/debug.
  debug(key, now) {
    const nodeId = this.ring.nodeFor(key);
    const node = this.nodes.get(nodeId);
    return {
      key,
      node: nodeId,
      hit: node.peek(key, now), // true = currently cached & fresh
    };
  }

  // Aggregate stats for /metrics and the performance report.
  stats(sampleKeys = []) {
    const perNode = [...this.nodes.values()].map((n) => n.stats());
    const hits = perNode.reduce((s, n) => s + n.hits, 0);
    const misses = perNode.reduce((s, n) => s + n.misses, 0);
    const total = hits + misses;
    return {
      nodeCount: this.nodes.size,
      virtualNodesPerNode: this.ring.virtualNodes,
      hits,
      misses,
      hitRate: total ? Number((hits / total).toFixed(4)) : 0,
      perNode,
      // If sample keys are supplied, show how evenly the ring spreads them.
      keyDistribution: sampleKeys.length ? this.ring.distribution(sampleKeys) : undefined,
    };
  }
}
