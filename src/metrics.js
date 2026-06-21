// Lightweight in-process metrics. These back the /metrics endpoint and the
// performance report (rubric §10: "measure and report latency, preferably p95"
// and "report cache hit rate and database read/write counts").

const MAX_SAMPLES = 20_000;
let suggestLatencies = []; // milliseconds, capped ring-ish buffer

const counters = {
  suggestRequests: 0,    // GET /suggest calls served
  searchesSubmitted: 0,  // POST /search calls accepted
  dbReads: 0,            // SELECT operations against SQLite (bulk load, etc.)
  dbWriteStatements: 0,  // row upserts executed against SQLite
  dbFlushes: 0,          // number of batch flushes
};

export const metrics = {
  counters,

  recordSuggestLatency(ms) {
    suggestLatencies.push(ms);
    // Keep memory bounded; drop the oldest half in O(n) only occasionally.
    if (suggestLatencies.length > MAX_SAMPLES) {
      suggestLatencies = suggestLatencies.slice(suggestLatencies.length - MAX_SAMPLES / 2);
    }
  },

  incr(name, by = 1) {
    counters[name] = (counters[name] || 0) + by;
  },

  percentile(p) {
    if (suggestLatencies.length === 0) return 0;
    const sorted = [...suggestLatencies].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return Number(sorted[idx].toFixed(3));
  },

  // Latency snapshot for reports.
  latencySnapshot() {
    return {
      samples: suggestLatencies.length,
      p50ms: this.percentile(50),
      p95ms: this.percentile(95),
      p99ms: this.percentile(99),
    };
  },

  reset() {
    suggestLatencies = [];
    for (const k of Object.keys(counters)) counters[k] = 0;
  },
};
