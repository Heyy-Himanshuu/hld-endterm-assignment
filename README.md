# Search Typeahead System

A search-as-you-type suggestion system built for the HLD end-term assignment. It
serves the top-10 popular suggestions for any prefix with sub-millisecond latency,
records search submissions, ranks results by **popularity + recency**, caches
suggestion results across **multiple logical cache nodes using consistent hashing**,
and reduces database load with **batched writes**.

> **Documentation map**
> - **README.md** (this file) — setup, how to run, API reference.
> - **[REPORT.md](REPORT.md)** — the formal project report (architecture, dataset, API docs, design trade-offs, performance).
> - **[docs/architecture.md](docs/architecture.md)** — architecture diagrams.

---

## Tech stack

| Layer | Choice | Why (1-liner) |
|---|---|---|
| Backend | Node.js + Express | Single language with the frontend; great for I/O-bound low-latency APIs |
| Primary store | SQLite (`better-sqlite3`) | Zero-setup single file; synchronous API makes batch semantics exact |
| Suggestion index | In-memory **Trie** with precomputed top-K | O(prefix length) lookups, no per-request DB scan |
| Cache | **N in-process logical nodes** + **consistent-hash ring** | Distributes prefixes across nodes; TTL + LRU + invalidation |
| Trending | Exponential **time-decay** score | Recency without permanently over-ranking old spikes |
| Writes | In-memory aggregation **buffer + WAL** | Coalesces repeated queries; crash recovery |
| Frontend | Vanilla HTML/CSS/JS | No build step; easiest to run locally |

---

## Quick start

```bash
# 1. Install dependencies (Node 18+ required)
npm install

# 2. Prepare the dataset (downloads real Wikipedia pageviews; falls back to
#    synthetic data so the 100k+ requirement can never fail) and load SQLite
npm run setup          # == npm run dataset && npm run ingest

# 3. Start the server
npm start              # http://localhost:3000
```

Open **http://localhost:3000**, start typing, and use ↑/↓ + Enter to pick a
suggestion.

### Other commands

```bash
npm run dataset    # (re)download/generate data/queries.tsv
npm run ingest     # (re)load data/queries.tsv into SQLite
npm run benchmark  # performance report: p50/p95 latency, hit rate, write reduction, ring balance
node scripts/screenshot.js   # capture UI screenshots (needs the server running + Chrome)
```

---

## Dataset

- **Source:** [Wikimedia "pageviews" hourly dumps](https://dumps.wikimedia.org/other/pageviews/) — real English Wikipedia article titles used as queries, with their real hourly **view counts** as popularity.
- **Size:** ~216k rows downloaded → ~215.9k distinct queries after normalization. (Comfortably above the 100k minimum.)
- **Guarantee:** if the download is unavailable, `scripts/download-dataset.js` tops up with realistic synthetic queries (Zipfian counts) so the size requirement always holds.
- **Curated head:** a small set of hand-set popular queries (`iphone`, `iphone 15`, `iphone charger`, `java tutorial`, …) is forced in with high counts so demos match the assignment's examples.
- **Format:** `query<TAB>count` per line. Ingestion lowercases/normalizes and aggregates duplicates into one row per distinct query.

See [REPORT.md §2](REPORT.md#2-dataset-source-and-loading-instructions) for full loading details.

---

## API reference

Base URL: `http://localhost:3000`

### `GET /suggest?q=<prefix>&mode=<basic|enhanced>`
Top-10 suggestions for a prefix.
- `q` — the prefix (case-insensitive; empty/missing → empty list).
- `mode` — `basic` (sort by all-time count) or `enhanced` (recency-aware blend). Default `enhanced`.

```bash
curl "localhost:3000/suggest?q=iphone&mode=basic"
```
```json
{
  "query": "iphone",
  "suggestions": [
    { "query": "iphone", "count": 100039 },
    { "query": "iphone 15", "count": 85008 }
  ],
  "cache": "miss",
  "mode": "basic"
}
```
`cache` is `hit`, `miss`, or `skip` (empty prefix).

### `POST /search`
Dummy search API. Records the query (batched) and returns a fixed message.
```bash
curl -X POST localhost:3000/search -H 'Content-Type: application/json' -d '{"query":"iphone 15"}'
```
```json
{ "message": "Searched" }
```
Empty/missing `query` → `400 { "error": "query is required" }`.

### `GET /trending`
Top-N queries right now, ranked by decayed recent score.
```json
{ "trending": [ { "query": "iphone 15", "score": 33.048 } ] }
```

### `GET /cache/debug?prefix=<prefix>&mode=<basic|enhanced>`
Shows which logical cache node owns the prefix key, and whether it's currently a hit.
```bash
curl "localhost:3000/cache/debug?prefix=iphone"
```
```json
{ "prefix": "iphone", "mode": "enhanced", "key": "enhanced:iphone", "node": "cache-node-0", "hit": true }
```

### `GET /metrics`
Latency percentiles, cache hit rate + per-node stats, DB read/write counts,
write-reduction factor, and consistent-hash key distribution.

### `POST /admin/flush`
Demo/ops helper: forces the batch buffer to flush immediately so updates appear in
`/suggest` and `/trending` without waiting for the interval.

### `GET /health`
`{ "ok": true, "queries": 215890 }`

---

## Project layout

```
src/
  server.js                 boot sequence + Express wiring
  config.js                 every tunable (ports, TTL, batch size, decay, weights)
  util.js                   normalize() + prefixesOf()
  metrics.js                latency histogram + counters
  db/sqlite.js              primary store: schema, batched upsert, bulk read
  index/trie.js             Trie with precomputed top-K per node
  cache/consistentHash.js   hash ring with virtual nodes
  cache/cacheNode.js        one logical node: Map + TTL + LRU + stats
  cache/distributedCache.js ring of N nodes (get/set/invalidate/debug/stats)
  services/suggestService.js   cache -> Trie suggestion flow + ranking
  services/searchService.js    buffer + WAL + flush + recovery
  services/trendingService.js  time-decay recency scoring
  routes.js                 all HTTP endpoints
scripts/
  download-dataset.js       Wikipedia pageviews -> TSV (synthetic fallback)
  ingest.js                 TSV -> SQLite (normalize + aggregate)
  benchmark.js              performance report
  screenshot.js             UI screenshots via system Chrome
public/                     index.html, app.js, styles.css
docs/                       architecture.md + screenshots/
```

---

## Performance (measured — see REPORT.md §5)

| Metric | Result |
|---|---|
| Cache **hit** latency | p50 ≈ 0.0008 ms, p95 ≈ 0.0012 ms |
| Cache **miss** (Trie) latency | p50 ≈ 0.013 ms, p95 ≈ 0.021 ms |
| Hit rate (Zipfian workload, 100k req) | **98.1%** |
| Consistent-hash balance (10k keys) | max deviation **5.2%** across 3 nodes |
| Batch write reduction (100k searches, 500 distinct) | **200×** fewer DB writes |
| Per-request DB reads after boot | **0** |
