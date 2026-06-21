# Design Decisions & Viva Preparation

This is the document to revise before the viva. It explains **what** was built,
**why** each choice was made, **what alternatives** existed, and the
**trade-offs**. The last section is a question bank with model answers.

> Mental model of the whole system in one sentence:
> **SQLite is the source of truth; a Trie is a fast in-memory index built from it;
> a consistent-hashing cache sits in front of the Trie; and writes are buffered and
> applied in batches so the source of truth is never hammered.**

---

## 0. The three data layers (know this cold)

| Layer | What it holds | Role | Rebuildable? |
|---|---|---|---|
| **SQLite** | `query, count, last_searched` | Durable source of truth | No — it *is* the truth |
| **Trie** | precomputed top-K per prefix | Fast lookup index (derived from SQLite) | Yes, at boot |
| **Cache** | per-prefix *result lists* | Avoid recomputing hot prefixes | Yes, just re-query the Trie |

When asked "where does X live?", map it to one of these three.

---

## 1. Backend: Node.js + Express

**Decision.** Node.js with Express.

**Why.**
- The workload is **I/O-bound and latency-sensitive** (many tiny requests), which is exactly Node's event-loop sweet spot.
- **One language end-to-end** (frontend + backend) reduces context-switching.
- Express is minimal and unopinionated — no framework magic to explain away in a viva.

**Alternatives & trade-offs.** Python + FastAPI was the main alternative (cleaner typing, auto Swagger) but adds a second language. A JVM/Go service would give true multithreading, but Node's single thread is an *advantage* here (see batch-write atomicity, §6).

---

## 2. Primary store: SQLite via better-sqlite3

**Decision.** SQLite, accessed with the synchronous `better-sqlite3` driver.

**Why.**
- **Zero setup** — one file on disk. Satisfies "easy to run locally" with no DB server or Docker.
- **Synchronous** driver: in single-threaded Node, a flush becomes a single blocking transaction that **cannot interleave** with request handling. This makes the batch-write semantics trivially correct and the DB write count *exact* (important for the perf report).
- Reliable enough for the demo; supports `INSERT … ON CONFLICT … RETURNING`, which lets a flush get the new count back **without a second read**.

**Alternatives & trade-offs.** Postgres/MySQL would be more "production", but need a server. Redis-as-primary loses durability semantics. SQLite's weakness is concurrent writers across processes — irrelevant here because all writes funnel through one batch writer.

---

## 3. Suggestion index: Trie with precomputed top-K (the core decision)

**Decision.** Build an in-memory **Trie (prefix tree)** at boot. Each node stores a
**precomputed, sorted top-K list** (K = `trieNodeCapacity` = 20) of the highest-count
queries beneath it.

**Why a Trie.** Typeahead is a *prefix* problem. A Trie walks one node per prefix
character, so a lookup is **O(L)** in the prefix length `L` — independent of dataset
size. Returning suggestions is then just reading an already-sorted list.

**Why precompute top-K per node.** Without it, a short prefix like `"a"` would match
hundreds of thousands of queries and we'd have to gather + sort them on every miss.
Precomputing means the answer is ready in O(K).

**Why K = 20 when we return 10.** The **enhanced** ranker re-sorts candidates by a
recency blend. Keeping a few more than 10 gives it room to promote a recently-hot
query above an all-time-popular one *within the prefix*.

**The trade-off (say this proactively in the viva).**
- **Cost = memory** (each query is referenced by every node on its path where it ranks top-K) **and slow writes** (changing a count means re-propagating top-K up that query's path).
- That write cost is **exactly why batch writes matter** (§6): we pay propagation once per flush, not once per search. The Trie decision and the batching decision reinforce each other.

**Alternatives & trade-offs.**
- `SELECT … WHERE query LIKE 'pre%' ORDER BY count DESC LIMIT 10` — simplest, but scans + sorts on every miss and degrades as data grows; also no in-memory speed.
- A sorted list / array + binary search on prefix ranges — works, but top-K still needs a sort per query.
- **Limitation we accept:** a query ranked, say, #30 by all-time count for a prefix won't be in the node's top-20, so recency can't lift it into suggestions until its count grows. Such surging queries still surface in **/trending** (which is not prefix-bound). Documented, intentional.

---

## 4. Distributed cache + consistent hashing

**Decision.** A cache layer of **N in-process logical nodes** (default 3). A
**consistent-hash ring with virtual nodes** decides which node owns each prefix key.
Each node is a `Map` with **per-key TTL** (30 s) and an **LRU cap** (5000 keys).

**Why a cache at all.** The rubric requires "use a cache before falling back to the
primary store." Hot prefixes (`"a"`, `"ip"`, `"ja"`) are requested constantly; caching
the *result list* avoids re-walking the Trie for them. Measured hit rate on a realistic
workload: **98%** (§REPORT).

**Why in-process logical nodes (not Redis/Docker).**
- The rubric literally says "multiple **logical** cache nodes" — *logical* is satisfied by N independent stores in one process.
- "Easy to run locally" → no external infra, single `npm start`.
- The graded concept is **consistent-hash routing + TTL/invalidation + hit/miss**, all fully demonstrable in-process.
- **Honest trade-off:** in-process nodes share fate and memory; a real system uses separate Redis processes/machines for fault isolation and horizontal scale. Each node sits behind a tiny `get/set/delete/peek` interface, so swapping to real Redis means reimplementing **only those four methods** — the ring and everything above stay untouched.

**Why consistent hashing instead of `hash(key) % N`.**
- With plain modulo, changing N → N±1 remaps **almost every** key, causing a cache-wide miss storm.
- With a hash ring, adding/removing a node only remaps the keys on that node's arc — on average **K/N** keys move.

**Why virtual nodes.** One ring point per physical node gives uneven arc lengths (uneven load). ~150 virtual points per node smooths the distribution. Measured: **5.2%** max deviation across nodes for 10k keys.

**Cache key design.** `"<mode>:<normalized prefix>"`. The mode prefix is needed because
`basic` and `enhanced` produce different lists for the same prefix.

**Expiry & invalidation (two mechanisms).**
1. **TTL (30 s):** bounds worst-case staleness even if nothing else happens.
2. **Targeted invalidation:** on each flush, for every changed query we drop the cached entries for *all its prefixes* in both modes. This makes count/rank updates visible immediately instead of waiting for TTL.

---

## 5. Trending + recency-aware ranking (the +20%)

**Decision.** Each query carries a single **exponentially time-decayed score**. On a
search: `score = score * 0.5^(elapsed / halfLife) + 1` (half-life = 10 min). `/trending`
sorts by this decayed score; `/suggest?mode=enhanced` blends it with all-time popularity.

**The four things the rubric asks to explain:**
1. **How recent searches are tracked** — one number + a timestamp per query, in a Map. Only queries searched *since boot* are tracked, not all 215k. O(1) memory per active query.
2. **How recency affects ranking** — `/trending` ranks purely by the decayed score. `/suggest` enhanced mode normalizes both signals to [0,1] *within the candidate set* and blends:
   `score = 0.6 * (count / maxCount) + 0.4 * (recent / maxRecent)`. Normalizing makes a count of 100,000 and a recent score of 30 comparable, so a surging query can overtake an all-time leader.
3. **How we avoid permanently over-ranking a brief spike** — the score is **decayed on read**. A query that stops being searched fades automatically (halves every 10 min); after ~1 hour a past spike has been halved ~6×. No cron job, no manual reset — staleness is intrinsic to the formula.
4. **How the cache is kept consistent when rankings change** — short TTL (30 s) plus targeted prefix invalidation on flush. Enhanced results are inherently time-varying, so the short TTL is the freshness/latency knob.

**Why exponential decay over a sliding window.**
- A windowed counter (e.g. "hits in the last hour", bucketed) is also valid and arguably more intuitive, but needs per-query bucket arrays and a sweep to expire buckets.
- Exponential decay is **O(1) memory and O(1) update**, continuous (no bucket-boundary jumps), and the half-life is a single tunable knob.
- Trade-off: decay never *exactly* forgets (asymptotic to 0), and "score" units are less interpretable than "N searches in the last hour."

**Demonstration.** Search `iphone 15` a few times, then type `ip`: in **enhanced** mode
`iphone 15` jumps **above** `iphone` even though `iphone` has a higher all-time count; in
**basic** mode `iphone` stays on top. (Visible in the screenshots.)

---

## 6. Batch writes + WAL (the +20%)

**Decision.** `POST /search` does **not** write to SQLite synchronously. It:
1. appends the query to a **write-ahead log** file (durability),
2. adds it to an **in-memory aggregation buffer** (`Map<query, count-in-window>`),
3. bumps the trending score,
4. returns `{"message":"Searched"}` immediately.

A **flush** runs every `batchIntervalMs` (2 s) **or** when the buffer holds
`batchMaxSize` (500) distinct queries — whichever comes first. The flush applies the
whole buffer to SQLite in **one transaction**, updates the Trie's top-K along changed
paths, invalidates affected cache prefixes, and truncates the WAL.

**Why batch.**
- **Aggregation:** 1,000 searches for `iphone` in a window become **one** `count += 1000` write, not 1,000 writes.
- **Amortized index cost:** the expensive Trie top-K propagation happens once per flush.
- Measured: **100,000 searches over 500 distinct queries → 500 DB writes = 200× reduction.**

**Why this is safe to do single-threaded.** Node is single-threaded and the flush is a
synchronous SQLite transaction, so **no `submit()` can interleave** with a flush. We
snapshot-and-reset the buffer at the top of the flush; new submissions land in a fresh
buffer. No locks needed.

**Failure trade-off (the rubric explicitly asks).**
- *Without* any log, a crash loses everything buffered-but-not-flushed (up to 2 s of searches).
- *With* the WAL, every accepted search is appended **before** we ack it, and the WAL is truncated **only after** a successful flush. On boot we **replay** the WAL, so acknowledged-but-unflushed searches are recovered. Re-applying is safe because writes are additive aggregations.
- **Residual risk:** we do **not** `fsync` on every append (that would defeat the throughput goal). A hard power loss could lose OS-buffered tail lines. The knob is *"fsync per write (fully durable, slow)"* vs *"batched append (fast, tiny loss window)"*; we chose the latter and documented it. For an analytics-style "search popularity" counter, losing a few counts is acceptable; for money you'd choose fsync or a real durable queue (Kafka).

**Alternatives.** A real message queue / log (Kafka, Redis Streams) is the production
answer — durable, replayable, decoupled. Our file WAL is the same idea at assignment scale.

---

## 7. Frontend: vanilla HTML/CSS/JS

**Decision.** A single static page served by Express; no framework, no build step.

**Why.** "Easy to run locally" — there's nothing to compile. It still covers every UI
requirement: **debounced** input (150 ms), suggestion dropdown, Enter/click submit,
dummy-response display, trending section, loading + error states, and **keyboard
navigation** (↑/↓/Enter/Esc). A live footer shows cache hit/miss + latency, which doubles
as a demo aid.

**Trade-off.** React/Vue would scale better for a large UI, but that's gold-plating here.

---

## 8. Things deliberately NOT built (scope discipline)

No auth, no microservices, no Redis/Docker, no rate limiting, no analytics dashboard.
Every module maps to a graded requirement. This is a conscious "follow the rubric exactly"
choice — and a good viva answer to "what would you add for production?" (answer below).

---

## 9. Viva question bank (with model answers)

**Q: Walk me through what happens when I type "ip".**
A: The browser debounces 150 ms, then calls `GET /suggest?q=ip&mode=enhanced`. The server
normalizes `"ip"`, forms key `enhanced:ip`, and the consistent-hash ring routes it to one
logical cache node. On a hit it returns the cached list. On a miss it walks the Trie to the
`i→p` node, reads its precomputed top-20, blends count+recency, takes the top 10, stores
that in the node with a 30 s TTL, and returns it.

**Q: Why is the suggest path fast?**
A: No DB call and no sorting at request time. Cache hit is a `Map` get (sub-microsecond);
cache miss is an O(prefix-length) Trie walk returning a pre-sorted list. Measured p95: 0.0012 ms (hit), 0.021 ms (miss).

**Q: How does the Trie get the top-10 without scanning?**
A: top-K is precomputed at every node during build and maintained incrementally on flush.
A node's list already holds the K highest-count queries beneath it, sorted.

**Q: What exactly is "distributed" about your cache?**
A: Keys are partitioned across N independent logical nodes by a consistent-hash ring; each
node has its own data, TTL clock, and stats. It's distributed in the *partitioning* sense.
I kept the nodes in-process for "easy to run", but each is behind a `get/set/delete/peek`
interface, so replacing them with real network Redis instances changes only those methods,
not the ring.

**Q: Why consistent hashing and not modulo?**
A: Modulo remaps nearly all keys when N changes (miss storm). The ring moves only ~K/N keys
when a node is added/removed. Virtual nodes keep the per-node share even (measured 5.2% max deviation).

**Q: What if two prefixes collide on the same node?**
A: That's expected and fine — a node holds many keys. Consistent hashing balances *load*
across nodes; it doesn't need one-key-per-node.

**Q: How do you prevent a one-day viral query from dominating forever?**
A: Trending uses time-decay, evaluated on read. Once searches stop, the score halves every
10 minutes and the query falls off — no manual cleanup. All-time popularity still lives in
the `count` column, so it remains reasonably ranked in *basic* suggestions, which is correct.

**Q: What happens to buffered searches if the process crashes mid-window?**
A: They're in the WAL (appended before ack, truncated only after a successful flush), so we
replay them on boot. The only loss window is OS-buffered WAL tail on a hard power loss
because we don't fsync per write — a deliberate throughput trade-off.

**Q: How do you measure the write reduction?**
A: `searchesSubmitted / dbWriteStatements` from `/metrics`. Repeated queries aggregate in the
buffer, so distinct-per-flush is the write count. Benchmark: 100k searches → 500 writes = 200×.

**Q: After a search, when do suggestions update?**
A: On the next flush (≤ 2 s, or immediately via `POST /admin/flush`). The flush updates the
Trie counts and invalidates the affected cache prefixes, so the new ranking shows up.

**Q: Cache invalidation strategy?**
A: Two layers — a 30 s TTL bounds staleness unconditionally, and targeted invalidation drops
every prefix of each changed query (both modes) on flush so updates are visible immediately.

**Q: Where's the bottleneck / how would you scale to millions of QPS?**
A: Reads scale horizontally (replicate the read service; the Trie is read-only between
flushes). The cache becomes real distributed Redis. Writes scale by moving the buffer to a
partitioned durable log (Kafka) with consumer workers doing batched DB upserts. The primary
store becomes a real RDBMS or a KV store. The architecture already separates these concerns.

**Q: Why SQLite and not Redis for the main data?**
A: Redis isn't durable by default and is a cache-shaped store. The source of truth needs
durability and is fine being slightly slow because the Trie+cache shield it from read traffic
and batching shields it from write traffic. After boot, per-request DB reads = 0.

**Q: Biggest weakness of your design?**
A: (1) The Trie's per-node top-K means a low-all-time-count but surging query can't enter
prefix suggestions until its count grows (mitigated by /trending). (2) In-process cache isn't
fault-isolated. (3) No fsync = tiny durability window. All three are documented and have
clear production upgrades.
