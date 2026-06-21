// Central configuration. Every tunable lives here so the design decisions are
// visible in one place (and so the viva answer to "where would you change X?"
// is always "config.js"). Values can be overridden with environment variables.

export const config = {
  // ---- server ----
  port: Number(process.env.PORT) || 3000,

  // ---- storage (primary durable store) ----
  dbPath: process.env.DB_PATH || 'data/typeahead.sqlite',
  datasetPath: process.env.DATASET_PATH || 'data/queries.tsv',

  // ---- write-ahead log (crash recovery for un-flushed search submissions) ----
  walPath: process.env.WAL_PATH || 'data/search-wal.log',

  // ---- suggestions ----
  maxSuggestions: 10,        // rubric: return at most 10 suggestions
  trieNodeCapacity: 20,      // top-K cached per Trie node. >10 so the enhanced
                             // (recency-aware) ranker has candidates to reorder.

  // ---- distributed cache ----
  cacheNodeCount: Number(process.env.CACHE_NODES) || 3, // number of logical nodes
  cacheVirtualNodes: 150,    // virtual nodes per physical node on the hash ring.
                             // Higher => smoother key distribution (less variance).
  cacheTtlMs: 30_000,        // suggestion-result TTL: bounds staleness to 30s
  cacheMaxKeysPerNode: 5000, // LRU cap per node (bounds memory)

  // ---- batch writes ----
  batchMaxSize: 500,         // flush when the buffer holds this many DISTINCT queries
  batchIntervalMs: 2000,     // ...or every 2s, whichever comes first
  newQueryInitialCount: 1,   // a brand-new query enters with count = 1

  // ---- trending / recency-aware ranking ----
  decayHalfLifeMs: 10 * 60_000, // a query's "recent score" halves every 10 minutes
  trendingLimit: 10,            // size of the trending list
  // Enhanced /suggest blends normalized historical popularity with normalized
  // recent activity:  score = HIST_WEIGHT*normCount + RECENCY_WEIGHT*normRecent
  histWeight: 0.6,
  recencyWeight: 0.4,
};
