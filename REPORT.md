# Project Report — Search Typeahead System

This report covers the five required sections: (1) architecture, (2) dataset source
and loading, (3) API documentation, (4) design choices and trade-offs, and
(5) performance. Deeper reasoning and a viva Q&A bank are in
[DECISIONS.md](DECISIONS.md).

---

## 1. Architecture

### Overview
The system has three data layers plus a thin HTTP layer:

- **SQLite (primary store)** — durable source of truth: `query, count, last_searched`.
- **Trie index (in-memory)** — a prefix tree built from SQLite at boot, with a
  precomputed top-K list at every node. Serves prefix lookups in O(prefix length).
- **Distributed cache** — N logical nodes; a consistent-hash ring routes each prefix
  key to one node. Caches the *result list* for a prefix with a TTL.
- **Express HTTP layer** — `/suggest`, `/search`, `/trending`, `/cache/debug`, `/metrics`.

Two background concerns wrap the write path: a **batch writer** (buffer + periodic
flush) and a **trending service** (time-decay recency scoring).

### Diagram
Full Mermaid + ASCII diagrams are in [docs/architecture.md](docs/architecture.md).
Summary of the two hot paths:

```
READ  (GET /suggest)
  prefix --normalize--> key "mode:prefix" --consistent hash--> cache node
    HIT  -> return cached list (sub-microsecond)
    MISS -> Trie walk (O(L)) -> rank -> store in node (TTL) -> return

WRITE (POST /search)
  query --normalize--> append WAL --> aggregation buffer (+1) --> trending.record()
       --> return {"message":"Searched"}    [no DB write here]
  flush (every 2s OR 500 distinct queries):
       one SQLite transaction (aggregated upserts)
       -> update Trie top-K on changed paths
       -> invalidate affected cache prefixes
       -> truncate WAL
```

### Boot sequence
`open SQLite → bulk-read all rows (1 read) → build Trie → create cache ring →
replay WAL → start periodic flush → listen`.

### Why this shape
The Trie shields the DB from *read* traffic; the cache shields the Trie from
*repeated* reads; the batch writer shields the DB from *write* traffic. After boot,
**per-request DB reads = 0**. Each concern is a separate module behind a small
interface, so any one (e.g. the in-process cache → real Redis) can be swapped without
touching the others.

---

## 2. Dataset source and loading instructions

### Source
**Wikimedia "pageviews" hourly dumps** — `https://dumps.wikimedia.org/other/pageviews/`.
Each line is `domain  page_title  view_count  bytes`. We keep English (`en`) article
titles as **queries** and their hourly **view counts** as popularity. This is real,
openly-licensed data with genuine frequency values.

- Rows downloaded: **~216,506**; distinct queries after normalization/aggregation: **~215,890** (well above the 100k minimum).
- **Guarantee:** if the network or a given dump file is unavailable, `download-dataset.js`
  tops up with realistic **synthetic** queries (Zipfian counts) so the size requirement
  can never fail the build.
- **Curated head:** a handful of queries (`iphone`, `iphone 15`, `iphone charger`,
  `java tutorial`, …) are forced in with high counts so demos match the assignment's examples.

### Format
`query<TAB>count` per line in `data/queries.tsv`. Example:
```
iphone	100000
iphone 15	85000
iphone charger	60000
java tutorial	40000
```

### Loading
```bash
npm run dataset   # download (or synthesize) -> data/queries.tsv
npm run ingest    # normalize + aggregate -> SQLite (data/typeahead.sqlite)
# or both:
npm run setup
```
Ingestion lowercases and whitespace-normalizes each query with the **same** `normalize()`
the API uses, then aggregates duplicates/case-variants into one row per distinct query
(the rubric's "derive counts by aggregation"). Observed top rows after load:
```
100039  iphone
 95193  google
 90711  youtube
 88530  chatgpt
 85008  iphone 15
```

---

## 3. API documentation

Base URL `http://localhost:3000`. (Also summarized in the README.)

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/suggest?q=<prefix>&mode=<basic\|enhanced>` | Up to 10 prefix suggestions, ranked |
| POST | `/search` `{ "query": "..." }` | Dummy search; records query (batched) |
| GET | `/trending` | Top-N by decayed recent score |
| GET | `/cache/debug?prefix=<p>&mode=<m>` | Owning cache node + hit/miss for the key |
| GET | `/metrics` | Latency, hit rate, DB counts, write reduction, ring distribution |
| POST | `/admin/flush` | Force a batch flush (demo helper) |
| GET | `/health` | Liveness + row count |

### `GET /suggest`
```bash
curl "localhost:3000/suggest?q=iphone&mode=basic"
```
```json
{ "query": "iphone", "mode": "basic", "cache": "miss",
  "suggestions": [ { "query": "iphone", "count": 100039 },
                   { "query": "iphone 15", "count": 85069 } ] }
```
- Empty/missing `q` → `{ "suggestions": [], "cache": "skip" }`.
- No matches → `{ "suggestions": [] }`.
- Mixed case (`IPHONE`) is normalized to `iphone`.
- `cache` ∈ `hit | miss | skip`.

### `POST /search`
```bash
curl -X POST localhost:3000/search -H 'Content-Type: application/json' -d '{"query":"iphone 15"}'
# -> { "message": "Searched" }
```
Missing/empty `query` → `400 { "error": "query is required" }`.

### `GET /trending`
```json
{ "trending": [ { "query": "iphone 15", "score": 33.048 } ] }
```

### `GET /cache/debug`
```json
{ "prefix": "qx", "mode": "basic", "key": "basic:qx", "node": "cache-node-1", "hit": false }
```

### `GET /metrics` (shape)
```json
{ "latency": { "p50ms": 0.06, "p95ms": 0.34 },
  "cache": { "hitRate": 0.98, "perNode": [...], "keyDistribution": {...} },
  "db": { "reads": 1, "writeStatements": 500, "flushes": 12 },
  "batch": { "searchesSubmitted": 100000, "writeReductionFactor": 200 } }
```

---

## 4. Design choices and trade-offs

Condensed here; full reasoning + alternatives in [DECISIONS.md](DECISIONS.md).

| Decision | Why | Key trade-off |
|---|---|---|
| **Node.js + Express** | I/O-bound, low-latency; one language with the UI | Single-threaded (but that makes batch flush atomic — an advantage here) |
| **SQLite (better-sqlite3)** | Zero-setup durable truth; sync API → exact write counts | Not multi-writer (fine: all writes funnel through one batcher) |
| **Trie + precomputed top-K** | O(prefix) lookups, pre-sorted results | Memory + slow writes → *motivates batching* |
| **In-process logical cache nodes** | "logical" per rubric; easy to run; concept fully shown | Not fault-isolated like real Redis (interface lets us swap) |
| **Consistent hashing + vnodes** | Adding/removing a node moves ~K/N keys, not all | Slightly more complex than modulo |
| **Exponential time-decay trending** | O(1) memory/update; auto-forgets spikes | "Score" less interpretable than a windowed count; never exactly 0 |
| **Buffer + WAL batch writes** | Aggregates duplicates; amortizes Trie updates; crash recovery | No per-write fsync → tiny loss window on power loss |
| **Vanilla frontend** | No build step; easiest to run | Less scalable than a framework for large UIs |

### Demonstrating basic vs enhanced ranking (real output)
After searching `iphone 15` several times then flushing:
```
BASIC (all-time count), q=iph:          ENHANCED (recency-aware), q=iph:
  100039  iphone                          score=0.910  recent=31.97  iphone 15   <-- promoted
   85069  iphone 15                       score=0.600  recent=0      iphone
   60000  iphone charger                  score=0.360  recent=0      iphone charger
   52012  iphone 15 pro                   score=0.312  recent=0      iphone 15 pro
```
`iphone 15` overtakes `iphone` in enhanced mode purely on recency, then decays back over
time — exactly the intended behavior. (See `docs/screenshots/01-suggestions.png` and `03-basic-mode.png`.)

### Demonstrating consistent hashing (real output)
```
cache miss -> hit transition:           prefix routing spread across nodes:
  /cache/debug qx -> node-1, hit:false     apple->node-1  banana->node-0  java->node-2
  (GET /suggest qx)                        python->node-1 iphone->node-2  weather->node-0
  /cache/debug qx -> node-1, hit:true      news->node-1   bitcoin->node-2
```
Each prefix deterministically maps to one node; keys spread across all three.

---

## 5. Performance report

Measured with `npm run benchmark` (in-process, against the real ~215.9k-query index;
numbers from a representative run on the dev machine).

### 5.1 Latency (p50 / p95 / p99)
| Path | p50 | p95 | p99 |
|---|---|---|---|
| **Cache hit** | 0.0008 ms | 0.0012 ms | 0.0038 ms |
| **Cache miss** (Trie lookup) | 0.0127 ms | 0.021 ms | 0.044 ms |

Both paths are well under a millisecond; the cache hit path is ~15× faster than a Trie
miss, and the miss path never touches SQLite.

### 5.2 Cache hit rate
Realistic **Zipfian** prefix workload (popular prefixes requested more often), 100,000
requests across ~1,857 distinct prefixes:
- **Hit rate: 98.1%**, mixed-workload p95 = 0.0015 ms.
- Per-node load (hits/total): node-0 ≈ 40.4k, node-1 ≈ 30.2k, node-2 ≈ 29.4k.

### 5.3 Database read/write counts
- **Per-request DB reads after boot: 0** — suggestions are served entirely from the
  Trie + cache. SQLite is read exactly **once** at boot to build the Trie.
- Writes happen only on flush, one statement per distinct query per flush.

### 5.4 Write reduction through batching
100,000 `POST /search` calls drawn from only 500 distinct queries:
- DB write statements: **500** (one per distinct query, aggregated in a single transaction).
- **Write reduction: 200× fewer DB writes.**
- (Live API check earlier: 81 searches → 3 writes = 27× with fewer distinct queries.)

### 5.5 Consistent-hash distribution
10,000 keys over 3 nodes (150 virtual nodes each):
- node-0 = 3,508, node-1 = 3,239, node-2 = 3,253.
- Ideal = 3,333/node; **max deviation = 5.2%** → well balanced.

### 5.6 Index build
- Trie built from ~215.9k queries in **~1.6–1.7 s** at boot (one-time cost).

### Summary
The design meets the low-latency goal (sub-ms p95 on both paths), keeps the cache hit
rate high under realistic skew, balances keys evenly across nodes, and cuts database
writes by two orders of magnitude under repeated-query load — while keeping per-request
DB reads at zero.
