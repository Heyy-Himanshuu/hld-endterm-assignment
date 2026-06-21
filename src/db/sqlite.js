import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { metrics } from '../metrics.js';

// PRIMARY DURABLE STORE.
//
// WHY SQLite (via better-sqlite3):
//  - Zero external setup: a single file on disk => satisfies the "easy to run
//    locally" non-functional requirement (no Docker, no DB server).
//  - better-sqlite3 is SYNCHRONOUS. In a single-threaded Node process that makes
//    a "batch flush" a single atomic, blocking transaction with no interleaving
//    request handling — which makes the batch-write semantics easy to reason
//    about and the write-count metric exact.
//  - It is the authoritative source of truth for (query, count, last_searched).
//    The Trie and the cache are both DERIVED from it and can be rebuilt at boot.
//
// NOTE: we enable SQLite's own WAL journal mode for write throughput. That is
// SQLite's internal journal and is unrelated to OUR application-level WAL
// (data/search-wal.log) used for batch-flush crash recovery — keep the two
// concepts distinct in the viva.

export function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS queries (
      query         TEXT PRIMARY KEY,   -- normalized query text
      count         INTEGER NOT NULL DEFAULT 0,
      last_searched INTEGER             -- epoch ms of the last recorded search
    );
    CREATE INDEX IF NOT EXISTS idx_queries_count ON queries(count DESC);
  `);

  // Upsert with RETURNING so a flush gets the NEW count back without a second
  // SELECT — keeps the DB-read count honest in the performance report.
  const upsertStmt = db.prepare(`
    INSERT INTO queries (query, count, last_searched)
    VALUES (@query, @delta, @now)
    ON CONFLICT(query) DO UPDATE SET
      count = count + excluded.count,
      last_searched = excluded.last_searched
    RETURNING count
  `);

  const countStmt = db.prepare('SELECT count FROM queries WHERE query = ?');
  const rowCountStmt = db.prepare('SELECT COUNT(*) AS n FROM queries');
  const allRowsStmt = db.prepare('SELECT query, count FROM queries');

  // Apply a whole aggregated batch in ONE transaction.
  // agg: Map<query, delta>. Returns Map<query, newCount> for index updates.
  const applyBatch = db.transaction((agg, now) => {
    const newCounts = new Map();
    for (const [query, delta] of agg) {
      const row = upsertStmt.get({ query, delta, now });
      newCounts.set(query, row.count);
      metrics.incr('dbWriteStatements');
    }
    return newCounts;
  });

  return {
    raw: db,

    // Bulk read used to build the Trie at boot. Counts as ONE db read — the
    // whole point of the in-memory index is that per-request reads never hit
    // the DB after this.
    allRows() {
      metrics.incr('dbReads');
      return allRowsStmt.all();
    },

    // Batch upsert (insert new / increment existing). Returns new counts.
    batchUpsert(agg, now) {
      if (agg.size === 0) return new Map();
      const result = applyBatch(agg, now);
      metrics.incr('dbFlushes');
      return result;
    },

    getCount(query) {
      metrics.incr('dbReads');
      const row = countStmt.get(query);
      return row ? row.count : 0;
    },

    rowCount() {
      return rowCountStmt.get().n;
    },

    close() {
      db.close();
    },
  };
}
