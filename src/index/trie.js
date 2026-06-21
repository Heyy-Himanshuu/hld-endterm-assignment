// IN-MEMORY PREFIX INDEX (Trie / prefix tree) with a precomputed top-K list at
// every node.
//
// WHY a Trie with precomputed top-K (the central data-structure decision):
//  - Suggestion lookup is O(L) in the prefix length L, NOT O(N) in the dataset
//    size. We walk L nodes and read an already-sorted list — no scan, no sort
//    at request time. That is what delivers low latency.
//  - The alternative, `SELECT ... WHERE query LIKE 'pre%' ORDER BY count DESC`,
//    must scan + sort matching rows on every miss and gets slower as data grows.
//
// THE TRADE-OFF (important viva point):
//  - Precomputing top-K costs memory (each query is referenced by every node
//    along its path where it ranks in the top-K) and makes WRITES expensive:
//    changing a count means re-propagating top-K up that query's path.
//  - That write cost is exactly WHY we batch writes — we pay the propagation
//    once per flush instead of once per search.

class TrieNode {
  constructor() {
    this.children = new Map(); // char -> TrieNode
    this.top = [];             // [{ q, count }] sorted by count desc, capped at capacity
  }
}

// Insert or update {q, count} inside a node's capped, sorted top-K list.
function upsertTop(top, q, count, capacity) {
  const i = top.findIndex((e) => e.q === q);
  if (i >= 0) {
    top[i].count = count; // count only ever grows; update in place
  } else if (top.length < capacity) {
    top.push({ q, count });
  } else if (count > top[top.length - 1].count) {
    top[top.length - 1] = { q, count }; // displace the weakest entry
  } else {
    return; // does not qualify for this node's top-K
  }
  // Re-sort: count desc, then query asc for stable, deterministic ordering.
  top.sort((a, b) => b.count - a.count || (a.q < b.q ? -1 : 1));
  if (top.length > capacity) top.length = capacity;
}

export class Trie {
  constructor(capacity = 20) {
    this.root = new TrieNode();
    this.capacity = capacity;
    this.size = 0; // number of distinct queries inserted
  }

  // Insert a brand-new query, or update the count of an existing one, and
  // propagate the value into the top-K list of every node along its path.
  upsert(query, count) {
    let node = this.root;
    upsertTop(node.top, query, count, this.capacity); // root holds global top-K
    for (const ch of query) {
      let next = node.children.get(ch);
      if (!next) {
        next = new TrieNode();
        node.children.set(ch, next);
      }
      node = next;
      upsertTop(node.top, query, count, this.capacity);
    }
    // Track distinct size: only the very first insert of a query increments it.
    if (!this._seen) this._seen = new Set();
    if (count > 0 && !this._seen.has(query)) {
      this._seen.add(query);
      this.size++;
    }
  }

  // Top-K suggestions for a prefix: walk to the prefix node, return its
  // precomputed list. O(prefix length). Returns [{ query, count }].
  prefixTopK(prefix, k) {
    let node = this.root;
    for (const ch of prefix) {
      node = node.children.get(ch);
      if (!node) return []; // no query starts with this prefix
    }
    return node.top.slice(0, k).map((e) => ({ query: e.q, count: e.count }));
  }

  // Bulk-build from an array of { query, count }. Insert highest-count first so
  // each node's top-K fills with the strongest candidates immediately (fewer
  // displacements => faster build).
  static build(rows, capacity = 20) {
    const trie = new Trie(capacity);
    rows.sort((a, b) => b.count - a.count);
    for (const r of rows) trie.upsert(r.query, r.count);
    return trie;
  }
}
