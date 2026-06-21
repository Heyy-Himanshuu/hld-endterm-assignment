import crypto from 'node:crypto';

// CONSISTENT HASHING RING (rubric §6: "Consistent hashing must be used to decide
// which cache node owns a prefix key").
//
// WHY consistent hashing instead of `hash(key) % N`:
//  - With plain modulo, changing the number of nodes from N to N+1 remaps almost
//    EVERY key to a different node -> a cache stampede / mass-miss event.
//  - With a hash ring, adding/removing a node only remaps the keys that fall on
//    the arc that node owns — on average K/N keys move, not all of them.
//
// WHY virtual nodes (replicas):
//  - If each physical node had a single point on the ring, the arc lengths
//    (and therefore the key shares) would be very uneven. Placing ~150 virtual
//    points per physical node smooths the distribution so each node owns a
//    roughly equal share of the key space (low variance).

function hashToInt(str) {
  // md5 -> first 8 hex chars -> 32-bit unsigned int. md5 is fine here: this is a
  // distribution hash, not a security primitive.
  const hex = crypto.createHash('md5').update(str).digest('hex').slice(0, 8);
  return parseInt(hex, 16) >>> 0;
}

export class ConsistentHashRing {
  constructor(nodeIds, virtualNodes = 150) {
    this.virtualNodes = virtualNodes;
    this.ring = [];        // sorted array of { hash, nodeId }
    this.nodeIds = [];
    for (const id of nodeIds) this.addNode(id, /* rebuild */ false);
    this._sort();
  }

  _sort() {
    this.ring.sort((a, b) => a.hash - b.hash);
  }

  addNode(nodeId, rebuild = true) {
    this.nodeIds.push(nodeId);
    for (let v = 0; v < this.virtualNodes; v++) {
      this.ring.push({ hash: hashToInt(`${nodeId}#${v}`), nodeId });
    }
    if (rebuild) this._sort();
  }

  removeNode(nodeId) {
    this.ring = this.ring.filter((p) => p.nodeId !== nodeId);
    this.nodeIds = this.nodeIds.filter((id) => id !== nodeId);
  }

  // Return the node that owns `key`: the first ring point clockwise from
  // hash(key), wrapping around to the start. Binary search => O(log V).
  nodeFor(key) {
    if (this.ring.length === 0) return null;
    const h = hashToInt(key);
    let lo = 0;
    let hi = this.ring.length - 1;
    if (h > this.ring[hi].hash) return this.ring[0].nodeId; // wrap around
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.ring[mid].hash < h) lo = mid + 1;
      else hi = mid;
    }
    return this.ring[lo].nodeId;
  }

  // Diagnostic: how many of `keys` land on each node. Used to prove the ring is
  // balanced (performance report + /metrics).
  distribution(keys) {
    const counts = Object.fromEntries(this.nodeIds.map((id) => [id, 0]));
    for (const k of keys) counts[this.nodeFor(k)]++;
    return counts;
  }
}
