import { normalize } from './util.js';
import { metrics } from './metrics.js';

// All HTTP routes in one place. Each handler is thin: it validates input and
// delegates to a service. Kept in a single factory so the wiring (which service
// backs which endpoint) is easy to read in one screen.

// Deterministic sample of prefix-like keys, used to demonstrate that the
// consistent-hash ring spreads keys evenly across nodes (no Math.random so the
// number is reproducible in the report).
function sampleKeys() {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const keys = [];
  for (const a of letters) {
    keys.push(`enhanced:${a}`);
    for (const b of letters) keys.push(`enhanced:${a}${b}`);
  }
  return keys; // 26 + 676 = 702 keys
}

export function registerRoutes(app, ctx) {
  const { suggestService, searchService, trending, cache, db, config } = ctx;

  // --- GET /suggest?q=<prefix>&mode=<basic|enhanced> -------------------------
  // Returns up to 10 prefix-matching suggestions sorted by the chosen ranking.
  app.get('/suggest', (req, res) => {
    const q = req.query.q ?? '';
    const mode = req.query.mode === 'basic' ? 'basic' : 'enhanced';
    const result = suggestService.suggest(q, mode);
    res.json({ query: q, ...result });
  });

  // --- POST /search { "query": "..." } ---------------------------------------
  // Dummy search API: returns "Searched" and records the query (batched write).
  app.post('/search', (req, res) => {
    try {
      const result = searchService.submit(req.body?.query);
      res.json(result); // { message: "Searched" }
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // --- GET /trending ---------------------------------------------------------
  // Top-N queries by decayed recent score (recency-aware).
  app.get('/trending', (_req, res) => {
    res.json({ trending: trending.top(config.trendingLimit, Date.now()) });
  });

  // --- GET /cache/debug?prefix=<prefix>&mode=<basic|enhanced> -----------------
  // Shows which logical cache node owns the prefix key and whether it's a
  // hit (currently cached & fresh) or a miss.
  app.get('/cache/debug', (req, res) => {
    const prefix = normalize(req.query.prefix ?? '');
    const mode = req.query.mode === 'basic' ? 'basic' : 'enhanced';
    const key = `${mode}:${prefix}`;
    const info = cache.debug(key, Date.now());
    res.json({ prefix, mode, ...info });
  });

  // --- GET /metrics ----------------------------------------------------------
  // Latency (p50/p95/p99), cache hit rate, DB read/write counts, write-reduction
  // ratio, and the ring's key distribution. Backs the performance report.
  app.get('/metrics', (_req, res) => {
    const c = metrics.counters;
    const writeReduction =
      c.dbWriteStatements > 0
        ? Number((c.searchesSubmitted / c.dbWriteStatements).toFixed(2))
        : null;
    res.json({
      latency: metrics.latencySnapshot(),
      cache: cache.stats(sampleKeys()),
      db: {
        reads: c.dbReads,
        writeStatements: c.dbWriteStatements,
        flushes: c.dbFlushes,
        rowCount: db.rowCount(),
      },
      batch: {
        searchesSubmitted: c.searchesSubmitted,
        dbWriteStatements: c.dbWriteStatements,
        writeReductionFactor: writeReduction, // searches per actual DB write
        pendingInBuffer: searchService.buffer.size,
      },
      suggestRequests: c.suggestRequests,
    });
  });

  // --- POST /admin/flush -----------------------------------------------------
  // Demo/ops helper: force the batch buffer to flush now so updates appear in
  // /suggest and /trending immediately (instead of waiting for the interval).
  app.post('/admin/flush', (_req, res) => {
    res.json(searchService.flush());
  });

  // --- GET /health -----------------------------------------------------------
  app.get('/health', (_req, res) => res.json({ ok: true, queries: db.rowCount() }));
}
