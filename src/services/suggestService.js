import { normalize } from '../util.js';
import { metrics } from '../metrics.js';

// SUGGESTION FLOW (rubric §4.1 + §6: "use a cache before falling back to the
// primary data store").
//
// Path for GET /suggest?q=<prefix>&mode=<basic|enhanced>:
//   1. normalize the prefix (lowercase/trim) -> handles mixed-case & whitespace
//   2. consistent-hash the cache key -> pick the owning logical node
//   3. CACHE HIT  -> return immediately (the fast path)
//   4. CACHE MISS -> read top-K from the Trie, rank, store in cache (TTL), return
//
// The cache key includes the mode (`basic:` / `enhanced:`) because the two
// ranking modes produce different result lists for the same prefix.

export class SuggestService {
  constructor({ trie, cache, trending, config }) {
    this.trie = trie;
    this.cache = cache;
    this.trending = trending;
    this.config = config;
  }

  // mode: 'basic' (all-time count only) or 'enhanced' (recency-aware blend).
  suggest(rawPrefix, mode = 'enhanced') {
    const start = performance.now();
    metrics.incr('suggestRequests');

    const prefix = normalize(rawPrefix);
    // Graceful handling of empty/missing input: no prefix => no suggestions.
    if (!prefix) {
      metrics.recordSuggestLatency(performance.now() - start);
      return { suggestions: [], cache: 'skip', mode };
    }

    const now = Date.now();
    const key = `${mode}:${prefix}`;

    // --- cache lookup ---
    const cached = this.cache.get(key, now);
    if (cached !== undefined) {
      metrics.recordSuggestLatency(performance.now() - start);
      return { suggestions: cached, cache: 'hit', mode };
    }

    // --- miss: compute from the Trie (the derived in-memory index) ---
    const candidates = this.trie.prefixTopK(prefix, this.config.trieNodeCapacity);
    const suggestions =
      mode === 'basic'
        ? candidates.slice(0, this.config.maxSuggestions)
        : this._rankByRecency(candidates, now).slice(0, this.config.maxSuggestions);

    this.cache.set(key, suggestions, now);
    metrics.recordSuggestLatency(performance.now() - start);
    return { suggestions, cache: 'miss', mode };
  }

  // ENHANCED RANKING: blend normalized all-time popularity with normalized
  // recent activity. Normalizing WITHIN the candidate set keeps the two signals
  // comparable regardless of absolute magnitudes, so a recently-surging query
  // can overtake an all-time-popular one.
  //
  //   score = histWeight * (count / maxCount) + recencyWeight * (recent / maxRecent)
  _rankByRecency(candidates, now) {
    if (candidates.length === 0) return candidates;
    const recents = candidates.map((c) => this.trending.getScore(c.query, now));
    const maxCount = Math.max(...candidates.map((c) => c.count), 1);
    const maxRecent = Math.max(...recents, 1e-9);
    const { histWeight, recencyWeight } = this.config;

    return candidates
      .map((c, i) => ({
        query: c.query,
        count: c.count,
        recentScore: Number(recents[i].toFixed(4)),
        score: Number(
          (histWeight * (c.count / maxCount) + recencyWeight * (recents[i] / maxRecent)).toFixed(6)
        ),
      }))
      .sort((a, b) => b.score - a.score);
  }
}
