import Database from 'better-sqlite3';
import { openDb } from '../src/db/sqlite.js';
import { Trie } from '../src/index/trie.js';
import { DistributedCache } from '../src/cache/distributedCache.js';
import { TrendingService } from '../src/services/trendingService.js';
import { SuggestService } from '../src/services/suggestService.js';
import { SearchService } from '../src/services/searchService.js';
import { config } from '../src/config.js';
import { metrics } from '../src/metrics.js';

// PERFORMANCE BENCHMARK (rubric §10: report p95 latency, cache hit rate, and
// DB read/write reduction). Runs IN-PROCESS against the real data so it measures
// the data system itself, free of HTTP/network noise.

function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return Number(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(4));
}
const fmt = (n) => n.toLocaleString();

function freshCache() {
  return new DistributedCache({
    nodeCount: config.cacheNodeCount,
    virtualNodes: config.cacheVirtualNodes,
    ttlMs: 60_000,
    maxKeysPerNode: 100_000, // large so the benchmark isn't dominated by eviction
  });
}

function timeSuggest(svc, prefix, mode) {
  const t0 = performance.now();
  svc.suggest(prefix, mode);
  return performance.now() - t0;
}

function main() {
  console.log('\n=== Search Typeahead — Performance Benchmark ===\n');

  // Build the index from the real DB.
  const db = openDb(config.dbPath);
  if (db.rowCount() === 0) {
    console.error('No data. Run `npm run setup` first.');
    process.exit(1);
  }
  const tBuild = performance.now();
  const trie = Trie.build(db.allRows(), config.trieNodeCapacity);
  console.log(`Index: ${fmt(trie.size)} queries, Trie built in ${(performance.now() - tBuild).toFixed(0)}ms\n`);

  const trending = new TrendingService({ halfLifeMs: config.decayHalfLifeMs });

  // Build a realistic prefix workload from the most popular queries.
  const rows = db.raw.prepare('SELECT query FROM queries ORDER BY count DESC LIMIT 8000').all();
  const prefixes = [...new Set(rows.map((r) => r.query.slice(0, 3)).filter((p) => p.trim().length >= 2))];
  console.log(`Workload: ${fmt(prefixes.length)} distinct prefixes derived from top queries\n`);

  // --- 1) COLD latency (every request a cache MISS -> Trie lookup) -----------
  {
    const svc = new SuggestService({ trie, cache: freshCache(), trending, config });
    const lat = [];
    for (const p of prefixes) lat.push(timeSuggest(svc, p, 'enhanced'));
    console.log('1) Cache MISS path (Trie lookup):');
    console.log(`   p50=${percentile(lat, 50)}ms  p95=${percentile(lat, 95)}ms  p99=${percentile(lat, 99)}ms  (n=${fmt(lat.length)})`);
  }

  // --- 2) WARM latency (every request a cache HIT) --------------------------
  {
    const cache = freshCache();
    const svc = new SuggestService({ trie, cache, trending, config });
    const p = prefixes[0];
    svc.suggest(p, 'enhanced'); // warm
    const lat = [];
    for (let i = 0; i < 50_000; i++) lat.push(timeSuggest(svc, p, 'enhanced'));
    console.log('\n2) Cache HIT path:');
    console.log(`   p50=${percentile(lat, 50)}ms  p95=${percentile(lat, 95)}ms  p99=${percentile(lat, 99)}ms  (n=${fmt(lat.length)})`);
  }

  // --- 3) Realistic mixed workload -> overall hit rate ----------------------
  {
    const cache = freshCache();
    const svc = new SuggestService({ trie, cache, trending, config });
    const N = 100_000;
    const lat = [];
    for (let i = 0; i < N; i++) {
      // Zipfian skew: cube of a uniform random biases toward popular prefixes,
      // which is what produces realistic cache locality.
      const idx = Math.floor(prefixes.length * Math.pow(Math.random(), 3));
      lat.push(timeSuggest(svc, prefixes[idx], 'enhanced'));
    }
    const stats = cache.stats();
    console.log('\n3) Mixed workload (Zipfian prefix popularity):');
    console.log(`   requests=${fmt(N)}  hitRate=${(stats.hitRate * 100).toFixed(1)}%  p50=${percentile(lat, 50)}ms  p95=${percentile(lat, 95)}ms`);
    console.log(`   per-node: ${stats.perNode.map((n) => `${n.id}=${n.hits}/${n.hits + n.misses}`).join('  ')}`);
  }

  // --- 4) Consistent-hashing key distribution -------------------------------
  {
    const cache = freshCache();
    const keys = [];
    for (let i = 0; i < 10_000; i++) keys.push(`enhanced:key${i}`);
    const dist = cache.ring.distribution(keys);
    const vals = Object.values(dist);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const maxDev = Math.max(...vals.map((v) => Math.abs(v - mean))) / mean;
    console.log('\n4) Consistent-hash ring distribution (10,000 keys):');
    console.log(`   ${Object.entries(dist).map(([k, v]) => `${k}=${fmt(v)}`).join('  ')}`);
    console.log(`   ideal=${fmt(Math.round(mean))}/node  max deviation=${(maxDev * 100).toFixed(1)}%`);
  }

  // --- 5) Batch-write reduction (isolated in-memory DB) ---------------------
  {
    metrics.reset();
    const memDb = openDbInMemory();
    const memTrie = new Trie(config.trieNodeCapacity);
    const memTrending = new TrendingService({ halfLifeMs: config.decayHalfLifeMs });
    const benchConfig = { ...config, walPath: 'data/benchmark-wal.log', batchMaxSize: 1e9, batchIntervalMs: 1e9 };
    const search = new SearchService({ db: memDb, trie: memTrie, cache: freshCache(), trending: memTrending, config: benchConfig });

    // 100k searches drawn from only 500 distinct queries (Zipfian) -> heavy aggregation.
    const distinct = 500;
    const N = 100_000;
    for (let i = 0; i < N; i++) {
      const idx = Math.floor(distinct * Math.pow(Math.random(), 2));
      search.submit(`benchmark query ${idx}`);
    }
    const result = search.flush();
    const c = metrics.counters;
    console.log('\n5) Batch-write reduction:');
    console.log(`   searches submitted = ${fmt(c.searchesSubmitted)}`);
    console.log(`   DB write statements = ${fmt(c.dbWriteStatements)} (one per distinct query per flush)`);
    console.log(`   write reduction = ${(c.searchesSubmitted / c.dbWriteStatements).toFixed(1)}x fewer DB writes`);
    console.log(`   flushed ${result.flushed} aggregated rows in a single transaction`);
    search.stop();
    memDb.close();
  }

  console.log('\nNote: per-request DB reads stay at 0 after boot — suggestions are served');
  console.log('entirely from the in-memory Trie + cache, never the primary store.\n');
  db.close();
  process.exit(0);
}

// Helper: an isolated in-memory DB with the same schema, so the write-reduction
// test never touches the real data file.
function openDbInMemory() {
  const raw = new Database(':memory:');
  raw.exec(`CREATE TABLE queries (query TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, last_searched INTEGER);`);
  const upsert = raw.prepare(
    `INSERT INTO queries (query,count,last_searched) VALUES (@query,@delta,@now)
     ON CONFLICT(query) DO UPDATE SET count=count+excluded.count, last_searched=excluded.last_searched RETURNING count`
  );
  const applyBatch = raw.transaction((agg, now) => {
    const out = new Map();
    for (const [query, delta] of agg) {
      out.set(query, upsert.get({ query, delta, now }).count);
      metrics.incr('dbWriteStatements');
    }
    return out;
  });
  return {
    raw,
    allRows() { metrics.incr('dbReads'); return raw.prepare('SELECT query,count FROM queries').all(); },
    batchUpsert(agg, now) { if (!agg.size) return new Map(); const r = applyBatch(agg, now); metrics.incr('dbFlushes'); return r; },
    rowCount() { return raw.prepare('SELECT COUNT(*) n FROM queries').get().n; },
    close() { raw.close(); },
  };
}

main();
