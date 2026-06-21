import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from './config.js';
import { openDb } from './db/sqlite.js';
import { Trie } from './index/trie.js';
import { DistributedCache } from './cache/distributedCache.js';
import { TrendingService } from './services/trendingService.js';
import { SuggestService } from './services/suggestService.js';
import { SearchService } from './services/searchService.js';
import { registerRoutes } from './routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Boot sequence. Order matters: DB -> derived Trie index -> cache -> services
// -> WAL recovery -> serve.
// ---------------------------------------------------------------------------
function boot() {
  // 1) Primary durable store.
  const db = openDb(config.dbPath);
  const rowCount = db.rowCount();
  if (rowCount === 0) {
    console.warn(
      '[boot] No data in SQLite. Run `npm run setup` (download + ingest dataset) first.'
    );
  }

  // 2) Build the in-memory Trie index from the DB (one bulk read). This is the
  //    "fall back to the primary store" layer the suggestion flow uses on a miss.
  const t0 = Date.now();
  const trie = Trie.build(db.allRows(), config.trieNodeCapacity);
  console.log(
    `[boot] Trie built: ${trie.size.toLocaleString()} queries in ${Date.now() - t0}ms`
  );

  // 3) Distributed cache (N logical nodes + consistent-hash ring).
  const cache = new DistributedCache({
    nodeCount: config.cacheNodeCount,
    virtualNodes: config.cacheVirtualNodes,
    ttlMs: config.cacheTtlMs,
    maxKeysPerNode: config.cacheMaxKeysPerNode,
  });
  console.log(
    `[boot] Cache ring: ${config.cacheNodeCount} logical nodes × ${config.cacheVirtualNodes} vnodes`
  );

  // 4) Services.
  const trending = new TrendingService({ halfLifeMs: config.decayHalfLifeMs });
  const suggestService = new SuggestService({ trie, cache, trending, config });
  const searchService = new SearchService({ db, trie, cache, trending, config });

  // 5) Crash recovery: replay any WAL entries left by a previous run.
  const recovered = searchService.recoverFromWal();
  if (recovered.recovered) {
    console.log(`[boot] Recovered ${recovered.recovered} search(es) from WAL`);
  }

  // 6) Start the periodic batch flush.
  searchService.startAutoFlush();

  // 7) HTTP server.
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));
  registerRoutes(app, { suggestService, searchService, trending, cache, db, config });

  const server = app.listen(config.port, () => {
    console.log(`[boot] Typeahead server on http://localhost:${config.port}`);
  });

  // Graceful shutdown: drain the buffer so we don't lose un-flushed searches.
  const shutdown = () => {
    console.log('\n[shutdown] draining buffer + closing DB...');
    searchService.stop();
    db.close();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

boot();
