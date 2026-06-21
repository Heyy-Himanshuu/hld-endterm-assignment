# Architecture

## Component diagram (Mermaid)

```mermaid
flowchart TD
  UI["Browser UI<br/>(public/ — debounced input, dropdown,<br/>trending, keyboard nav)"]

  subgraph Server["Express server (src/server.js)"]
    direction TB
    R["Routes (src/routes.js)<br/>/suggest /search /trending<br/>/cache/debug /metrics"]

    subgraph Read["READ PATH (low latency)"]
      direction TB
      SUG["SuggestService"]
      DC["DistributedCache<br/>(consistent-hash ring)"]
      N0["cache-node-0"]
      N1["cache-node-1"]
      N2["cache-node-2"]
      TR["Trie index<br/>(top-K per node)"]
    end

    subgraph Write["WRITE PATH (batched)"]
      direction TB
      SS["SearchService<br/>buffer + WAL"]
      TRD["TrendingService<br/>(time-decay scores)"]
    end

    DB["SQLite primary store<br/>(query, count, last_searched)"]
    WAL["WAL file<br/>data/search-wal.log"]
  end

  UI -->|"GET /suggest"| R --> SUG --> DC
  DC -->|"ring.nodeFor(key)"| N0 & N1 & N2
  SUG -.->|"miss"| TR
  UI -->|"POST /search"| R --> SS
  SS -->|"append"| WAL
  SS -->|"flush: batch upsert"| DB
  SS -->|"on flush: update top-K"| TR
  SS -->|"on flush: invalidate prefixes"| DC
  SS -->|"record()"| TRD
  R -->|"GET /trending"| TRD
  DB -->|"bulk load at boot"| TR
```

## ASCII view (read + write paths)

```
                              ┌──────────────────────────────┐
                              │        Browser UI             │
                              │  debounced typeahead, dropdown │
                              │  trending, keyboard nav        │
                              └───────────────┬───────────────┘
                                              │ HTTP
              ┌───────────────────────────────┼─────────────────────────────────┐
              │                Express server (routes.js)                        │
              │                               │                                   │
  GET /suggest?q=pre                 POST /search {query}              GET /trending
              │                               │                                   │
              ▼                               ▼                                   ▼
     ┌──────────────────┐         ┌────────────────────────┐          ┌──────────────────┐
     │  SuggestService  │         │     SearchService      │          │ TrendingService  │
     └───────┬──────────┘         │  (batch buffer + WAL)  │          │  decay scores    │
             │                    └───────┬──────────┬─────┘          └──────────────────┘
             ▼                            │ append    │ flush (size/interval)
 ┌────────────────────────┐              ▼           ▼
 │   DistributedCache      │       ┌──────────┐  ┌─────────────────────────────────────┐
 │  consistent-hash ring   │       │ WAL file │  │ 1) batch upsert  -> SQLite          │
 │  ┌──────┐┌──────┐┌─────┐│       │ (replay  │  │ 2) update Trie top-K (changed paths)│
 │  │node-0││node-1││node2││       │  on boot)│  │ 3) invalidate affected cache prefixes│
 │  └──────┘└──────┘└─────┘│       └──────────┘  └─────────────────────────────────────┘
 └───────────┬─────────────┘
   miss      │ hit -> return
             ▼
 ┌────────────────────────┐        ┌────────────────────────────┐
 │  Trie index (in-memory) │◀──────│  SQLite primary store       │
 │  precomputed top-K/node │ boot  │  (query, count, last_searched)
 └────────────────────────┘  load  └────────────────────────────┘
```

## Request flows

**Suggest (read):** `normalize(prefix)` → build cache key `mode:prefix` →
`ring.nodeFor(key)` picks one logical node → **hit** returns immediately; **miss**
reads the Trie's precomputed top-K, ranks (basic = count; enhanced = count+recency
blend), stores the result in that node with a TTL, returns.

**Search (write):** `normalize(query)` → append to WAL (durability) → add to the
in-memory aggregation buffer → bump the trending decay score → return
`{"message":"Searched"}`. A background flush (every `batchIntervalMs` or when the
buffer hits `batchMaxSize`) applies the whole buffer to SQLite in one transaction,
updates the Trie's top-K along changed paths, invalidates affected cache prefixes,
and truncates the WAL.

**Boot:** open SQLite → bulk-read all rows once → build the Trie → create the
cache ring → replay any leftover WAL entries → start the periodic flush → listen.
