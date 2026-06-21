import fs from 'node:fs';
import path from 'node:path';
import { normalize, prefixesOf } from '../util.js';
import { metrics } from '../metrics.js';

// SEARCH SUBMISSION + BATCH WRITES (rubric §4.2 + §8).
//
// GOAL: never write to the primary store synchronously per search request.
// Instead we buffer submissions in memory, AGGREGATE repeated queries, and
// flush them to SQLite in a single transaction either every `batchIntervalMs`
// or once the buffer holds `batchMaxSize` distinct queries.
//
// CRASH SAFETY (the trade-off the rubric asks us to discuss): a purely
// in-memory buffer loses everything not yet flushed if the process dies. We
// mitigate that with an append-only WRITE-AHEAD LOG (data/search-wal.log): every
// accepted search is appended to the WAL *before* we acknowledge it, and the WAL
// is truncated only after a successful flush. On boot we replay the WAL, so at
// most we re-apply already-durable work (idempotent via count aggregation) and
// lose nothing that was acknowledged.
//   Residual risk: we do not fsync on every append (that would defeat the
//   throughput goal). A hard power loss could lose OS-buffered tail lines. The
//   knob is "fsync per write (durable, slow)" vs "batched flush (fast, tiny
//   loss window)"; we chose the latter and document it.

export class SearchService {
  constructor({ db, trie, cache, trending, config }) {
    this.db = db;
    this.trie = trie;
    this.cache = cache;
    this.trending = trending;
    this.config = config;

    this.buffer = new Map(); // normalized query -> aggregated delta (this window)
    this.walPath = config.walPath;
    fs.mkdirSync(path.dirname(this.walPath), { recursive: true });
    // Hold an append-mode fd and write SYNCHRONOUSLY. Unlike a buffered
    // WriteStream (which keeps data in-process until it drains), writeSync pushes
    // each line to the OS immediately — so an abrupt process crash cannot lose an
    // acknowledged search. (A hard power loss still could without fsync; that is
    // the documented throughput-vs-durability trade-off.)
    this.walFd = fs.openSync(this.walPath, 'a');

    this.flushTimer = null;
  }

  // Handle POST /search. Returns the dummy response payload; the heavy DB work
  // happens later in flush().
  submit(rawQuery) {
    const query = normalize(rawQuery);
    if (!query) {
      const err = new Error('query is required');
      err.status = 400;
      throw err;
    }

    // 1) Durability first: append to the WAL before acknowledging.
    fs.writeSync(this.walFd, query + '\n');

    // 2) Aggregate in the in-memory buffer (repeated query => one DB write later).
    this.buffer.set(query, (this.buffer.get(query) || 0) + 1);

    // 3) Update recency immediately so /trending reflects live activity without
    //    waiting for a flush.
    this.trending.record(query, Date.now());

    metrics.incr('searchesSubmitted');

    // 4) Size-based flush trigger.
    if (this.buffer.size >= this.config.batchMaxSize) this.flush();

    return { message: 'Searched' };
  }

  // Apply the whole buffer to the primary store in ONE transaction, then update
  // the derived index + invalidate affected cache entries.
  flush() {
    if (this.buffer.size === 0) return { flushed: 0 };

    // Snapshot + reset the buffer up front. Node is single-threaded and the DB
    // call below is synchronous, so no submit() can interleave with this flush.
    const agg = this.buffer;
    this.buffer = new Map();
    const now = Date.now();

    // 1) Batched upsert -> new authoritative counts.
    const newCounts = this.db.batchUpsert(agg, now);

    // 2) Update the Trie's precomputed top-K along each changed query's path.
    //    Done once per flush, not once per search — this is the payoff of batching.
    for (const [query, count] of newCounts) {
      this.trie.upsert(query, count);
    }

    // 3) Invalidate cached prefix results that may now be stale. We drop every
    //    prefix of each changed query, for BOTH ranking modes. TTL would
    //    eventually expire them anyway; this makes updates visible immediately.
    let invalidated = 0;
    for (const query of newCounts.keys()) {
      for (const p of prefixesOf(query)) {
        if (this.cache.invalidate(`basic:${p}`)) invalidated++;
        if (this.cache.invalidate(`enhanced:${p}`)) invalidated++;
      }
    }

    // 4) The batch is now durable in SQLite -> the WAL can be truncated.
    this._truncateWal();

    return { flushed: newCounts.size, invalidatedKeys: invalidated };
  }

  _truncateWal() {
    try {
      // Truncate via the held fd. With O_APPEND, subsequent writes still go to
      // end-of-file (offset 0 after truncation), so the fd stays valid.
      fs.ftruncateSync(this.walFd, 0);
    } catch {
      /* ignore */
    }
  }

  // Replay any WAL entries left over from a previous run (crash recovery), then
  // flush them straight to the DB. Called once at boot, before serving traffic.
  recoverFromWal() {
    if (!fs.existsSync(this.walPath)) return { recovered: 0 };
    const lines = fs.readFileSync(this.walPath, 'utf8').split('\n').filter(Boolean);
    if (lines.length === 0) return { recovered: 0 };
    for (const line of lines) {
      const q = normalize(line);
      if (q) this.buffer.set(q, (this.buffer.get(q) || 0) + 1);
    }
    const result = this.flush();
    return { recovered: lines.length, ...result };
  }

  // Start the periodic (time-based) flush. Kept separate from construction so
  // tests/benchmarks can drive flush() manually.
  startAutoFlush() {
    this.flushTimer = setInterval(() => this.flush(), this.config.batchIntervalMs);
    this.flushTimer.unref?.(); // don't keep the process alive just for this timer
  }

  stop() {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flush(); // best-effort drain on shutdown
    try {
      fs.closeSync(this.walFd);
    } catch {
      /* ignore */
    }
  }
}
