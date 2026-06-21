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

---

## 10. High-Level Design (HLD) viva question bank — subject concepts

This section maps the project to the **HLD / system-design concepts** an examiner will
test. Each answer states the concept, then how this project applies it (and what you'd
do at real scale). This is the "design Autocomplete / Typeahead" interview, grounded in
code you actually wrote.

### 10.1 Requirements & scope

**Q: What are the functional vs non-functional requirements of a typeahead system?**
- **Functional:** as the user types a prefix, return the top-N (here 10) matching
  suggestions ranked by popularity (and recency); record searches; surface trending.
- **Non-functional:** **very low latency** (suggestions must feel instant, < ~100 ms
  end-to-end, ideally < 10 ms server-side), **high availability** (slightly stale
  suggestions are acceptable — favors AP), **scalability** (read-heavy), **eventual
  consistency** of counts, and cost efficiency.

**Q: Is this system read-heavy or write-heavy?**
A: **Read-heavy.** Every keystroke (debounced) is a read; searches are far fewer. So we
optimize the read path hardest (in-memory Trie + cache, 0 DB reads/request) and make the
write path cheap and asynchronous (batching). This read/write asymmetry is the single most
important driver of the architecture.

### 10.2 Back-of-the-envelope estimation (capacity planning)

**Q: Do a rough capacity estimate for a large autocomplete service.**
A: Suppose 5B searches/day ≈ ~58k searches/sec. Each search is ~4–6 keystrokes that each
fire a (debounced) suggest call → say 5× → **~300k suggest QPS** average, multiply by ~2–3
for peak → ~1M QPS peak. Storage: ~100B distinct historical queries is unrealistic; we keep
only the **top few hundred million** weighted phrases (long tail is pruned). A trie of a few
hundred million phrases is tens of GB → **sharded across many machines and held in RAM**.
Bandwidth: each response ~ a few hundred bytes × QPS. The point of the estimate: reads
dominate, the working set fits in RAM if pruned, and we must shard.

### 10.3 High-level architecture at scale

**Q: Draw the production architecture (beyond this single process).**
A: `Client (debounce) → CDN/edge cache → Load balancer → stateless Suggest servers
(hold trie shards in RAM) → Distributed cache (Redis cluster) → ` and a **separate write
pipeline**: `search events → message queue (Kafka) → stream/batch aggregators → updates the
weighted trie (offline build) → pushed to suggest servers`. This project collapses all of
that into one Node process, but the *roles* map 1:1 (Express = LB+app, DistributedCache =
Redis cluster, SearchService buffer/WAL = the Kafka+aggregator pipeline, SQLite = the
durable store / offline build input).

**Q: Why keep the suggest servers stateless?**
A: Statelessness lets a load balancer send any request to any server and lets you scale
horizontally by just adding machines. The state (the trie) is a read-only replica rebuilt
from the source of truth, so losing a server loses no data.

### 10.4 Data structures — Trie and alternatives

**Q: Why a Trie for autocomplete, and what are the alternatives?**
A: Autocomplete is a **prefix-match** problem; a trie gives **O(L)** prefix lookup
independent of corpus size and naturally groups completions under a prefix node.
Alternatives: (a) a **sorted list + binary search** on prefix ranges (works, but top-K
needs sorting); (b) **DB `LIKE 'pre%'`** with an index (simple, but scans/sorts per query
and won't hit RAM speed); (c) **ternary search tree** (memory-friendlier trie variant);
(d) **FST / DAWG** (compressed automaton — what Lucene/Elasticsearch use for suggesters).
We precompute **top-K per node** so the answer is ready without scanning subtrees.

**Q: How would you shard a trie that doesn't fit on one machine?**
A: Partition by prefix. Simplest: shard on the **first 1–2 characters** (or a hash of the
prefix) so all completions of a prefix live on one shard → a single-shard lookup.
**Problem: skew** — common prefixes ("a", "th") get huge/hot shards. Fixes: split hot
prefixes further, replicate hot shards, or route by a balanced hash. This is exactly the
*hot-key / hotspot* problem from the sharding topic.

### 10.5 Caching — strategies, eviction, failure modes

**Q: Which caching strategy is this — cache-aside, write-through, or write-back?**
A: The read path is **cache-aside (lazy loading)**: on a miss we compute from the Trie and
populate the cache. The write path to the DB is effectively **write-back (write-behind)**:
searches are buffered and flushed in batches rather than written through synchronously.
Knowing these names is classic HLD viva fodder.

**Q: What eviction policy do you use and what are the options?**
A: Each cache node uses **LRU** (oldest-inserted evicted first via Map ordering) plus a
**TTL**. Options: **LRU** (recency), **LFU** (frequency — better for stable hot sets),
**FIFO**, **random**, **TTL-only**. LRU + TTL is the common default for suggestion caches.

**Q: What is a cache stampede / thundering herd, and does your design have it?**
A: When a hot key expires, many concurrent requests all miss and hit the backend at once.
At scale you mitigate with **single-flight/locking** (one request recomputes, others wait),
**probabilistic early recomputation**, or **stale-while-revalidate**. In this project a
"backend miss" is just a microsecond Trie walk, so the herd is harmless — but I'd call out
the mitigation for a real Redis+DB setup.

**Q: Hot keys — what if one prefix ("a") gets a huge share of traffic?**
A: Consistent hashing balances keys across nodes but a *single* hot key still lands on one
node. Fixes: replicate hot keys across multiple nodes, add a small per-server local cache in
front (we effectively have an L1 by serving from RAM), or key-splitting. This is the
hot-partition problem again, at the cache layer.

### 10.6 Consistent hashing (the headline HLD topic)

**Q: Explain consistent hashing and why it beats `hash % N`.**
A: Map both nodes and keys onto a hash ring [0, 2^32); a key is owned by the next node
clockwise. With `hash % N`, changing N remaps ~**all** keys (mass cache miss, rebalancing
storm). With the ring, adding/removing a node only remaps the keys on **that node's arc** —
about **K/N** keys move. This is what makes elastic scaling and node failure cheap.

**Q: What are virtual nodes and why are they essential?**
A: With one point per node, arc lengths (load shares) are uneven and removing a node dumps
its entire arc onto a single neighbor. Giving each physical node **many virtual points**
(~100–200) spreads its share across the ring → even load, smooth rebalancing, and support
for **heterogeneous** nodes (give bigger machines more vnodes). Measured here: 5.2% max
deviation across 3 nodes with 150 vnodes.

**Q: Where is consistent hashing used in real systems?**
A: Amazon **DynamoDB**, **Cassandra**, **Riak** (data partitioning), **memcached** clients
(ketama), CDNs and L7 load balancers (e.g. Google **Maglev**), and sharded caches — anywhere
you partition data/traffic across a changing set of nodes.

**Q: What happens to your data when a cache node dies?**
A: Its keys' next requests become misses and get recomputed onto the surviving node the ring
now routes them to — graceful degradation, no correctness loss (cache is rebuildable). In a
*data* store you'd pair the ring with **replication** (store each key on the next R nodes).

### 10.7 Databases — SQL/NoSQL, sharding, replication

**Q: SQL vs NoSQL for the primary store here, and at scale?**
A: For the assignment, SQLite (relational) is plenty — single key (`query`), simple counts.
At scale a **key-value / wide-column store** (DynamoDB, Cassandra) fits better: the access
pattern is point lookups/increments by query key, it shards horizontally, and we don't need
joins or strong multi-row transactions. The choice follows the **access pattern**, not habit.

**Q: How do you scale the database for reads and writes?**
A: **Reads:** add **read replicas** (async replication) and front with cache — but here the
Trie removes per-request reads entirely. **Writes:** **batch** (this project, 200× fewer
writes), **shard/partition** by query key to spread write load, and use a queue to absorb
spikes. **Replication** gives availability; **sharding** gives write throughput.

**Q: Sync vs async replication trade-off?**
A: Sync = no data loss on failover but higher write latency and reduced availability under
partition; async = fast and available but a failover can lose the last few writes. For
search-count analytics, **async** is the right call (a few lost counts don't matter).

### 10.8 CAP, consistency, and the write pipeline

**Q: Where does this system sit on CAP?**
A: It favors **AP** — availability + partition tolerance with **eventual consistency**.
A user seeing a count that's a couple of seconds stale (pre-flush) or a suggestion list from
a slightly old trie build is completely acceptable. We trade strong consistency for latency
and availability, which is the correct trade-off for autocomplete.

**Q: How would the search-counting pipeline look at scale (batch vs stream)?**
A: Search events → **Kafka** → consumers do **windowed aggregation** (e.g. Spark/Flink) →
periodically rebuild/patch the weighted trie that gets shipped to suggest servers. Often a
**lambda architecture**: a **batch layer** rebuilds the authoritative trie nightly and a
**speed layer** applies recent deltas for freshness. Our `buffer + periodic flush + Trie
top-K update` is the same idea in miniature.

**Q: Why batch writes instead of writing per search? (HLD framing)**
A: It's **write coalescing** to protect the datastore: turn N writes for the same key into
one, amortize index maintenance, and convert random per-request I/O into sequential batched
I/O. The cost is **freshness lag** and a **crash window** (handled by the WAL). This is the
generic "buffer + flush" / write-behind pattern.

### 10.9 Top-K, trending, and probabilistic structures

**Q: At billions of queries, how do you count popularity without storing every query?**
A: Use **approximate, sublinear-memory** structures: a **Count-Min Sketch** to estimate
frequencies in fixed memory (it overestimates, never underestimates) combined with a
**min-heap of the current top-K** ("heavy hitters"). For cardinality you'd use
**HyperLogLog**. We store exact counts because 100k–200k rows fit easily; I'd name CMS as the
scale answer.

**Q: How do you compute "trending" and avoid a one-day spike ranking forever?**
A: Two standard approaches: **sliding-window counts** (bucketed counters that expire) or
**exponential time decay** (this project: `score = score·0.5^(Δt/halfLife) + 1`). Decay is
O(1) memory/update and forgets automatically because the score is decayed on read — old
spikes halve every half-life and sink. Trade-off: decay never hits exactly zero and its units
are less interpretable than "hits in the last hour."

**Q: How would you add personalization or location-aware suggestions?**
A: Blend a global ranking with a per-user/per-region signal: maintain smaller per-segment
tries or re-rank the global top-K with a personalization score at request time (keep the heavy
lifting offline). It's a re-ranking layer on top of the same top-K candidate generation.

### 10.10 Latency, load balancing, availability

**Q: How do you minimize end-to-end latency?**
A: **Client:** debounce keystrokes (150 ms here) to cut request volume; cache responses in
the browser. **Edge:** CDN/edge caches for very common prefixes. **Server:** in-RAM trie +
distributed cache, no synchronous DB on the hot path. **Network:** keep responses tiny.
Measure **p95/p99** (tail latency), not just averages — tails are what users feel.

**Q: What load-balancing strategy would you use?**
A: Stateless suggest servers behind **round-robin / least-connections**. If servers hold
*different trie shards*, route by **consistent hashing on the prefix** so a prefix always hits
the server that holds its shard (cache affinity). Add health checks + failover for availability.

**Q: How do you make the service fault tolerant?**
A: Stateless, replicated suggest servers (lose one, LB reroutes); cache nodes are rebuildable
and the ring degrades gracefully on node loss; the datastore is replicated; the write pipeline
uses a durable, replayable log (Kafka / our WAL). No single point of failure on the hot path.

**Q: How would a Bloom filter help here?**
A: A **Bloom filter** of known prefixes can cheaply reject prefixes that have *no*
completions before doing any trie/cache work — useful to shed load from garbage/typo
prefixes at scale (with the usual false-positive, never-false-negative caveat).

**Q: One-line summary tying it together.**
A: It's a **read-optimized, eventually-consistent** system: serve reads from a sharded
in-RAM index fronted by a consistently-hashed distributed cache, and absorb writes through a
durable, batched, write-behind pipeline — trading a little freshness for large gains in
latency, availability, and datastore protection.
