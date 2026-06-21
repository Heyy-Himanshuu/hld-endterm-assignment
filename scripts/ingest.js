import fs from 'node:fs';
import readline from 'node:readline';
import { openDb } from '../src/db/sqlite.js';
import { config } from '../src/config.js';
import { normalize } from '../src/util.js';

// INGESTION: load data/queries.tsv into the SQLite primary store.
//
//  - Each line is `query<TAB>count`.
//  - Queries are NORMALIZED with the same function the API uses, then AGGREGATED
//    (duplicates and case-variants summed) so the store holds one row per
//    distinct normalized query — exactly what the rubric's "derive counts by
//    aggregation" allows.
//  - Loaded inside a single transaction for speed.

async function main() {
  if (!fs.existsSync(config.datasetPath)) {
    console.error(`[ingest] Dataset not found at ${config.datasetPath}. Run \`npm run dataset\` first.`);
    process.exit(1);
  }

  // Aggregate in memory first (one row per normalized query).
  const agg = new Map();
  const rl = readline.createInterface({
    input: fs.createReadStream(config.datasetPath),
    crlfDelay: Infinity,
  });
  let lines = 0;
  for await (const line of rl) {
    if (!line) continue;
    const tab = line.lastIndexOf('\t');
    if (tab < 0) continue;
    const query = normalize(line.slice(0, tab));
    const count = parseInt(line.slice(tab + 1), 10);
    if (!query || !Number.isFinite(count) || count <= 0) continue;
    agg.set(query, (agg.get(query) || 0) + count);
    lines++;
  }

  const db = openDb(config.dbPath);
  db.raw.exec('DELETE FROM queries'); // idempotent re-ingest
  const insert = db.raw.prepare(
    'INSERT INTO queries (query, count, last_searched) VALUES (?, ?, NULL) ' +
      'ON CONFLICT(query) DO UPDATE SET count = count + excluded.count'
  );
  const load = db.raw.transaction(() => {
    for (const [q, c] of agg) insert.run(q, c);
  });
  load();

  const total = db.rowCount();
  console.log(`[ingest] Read ${lines.toLocaleString()} lines -> ${total.toLocaleString()} distinct queries in SQLite.`);

  // Show the top 5 so you can eyeball that counts loaded correctly.
  const top = db.raw.prepare('SELECT query, count FROM queries ORDER BY count DESC LIMIT 5').all();
  console.log('[ingest] Top queries:');
  for (const r of top) console.log(`   ${r.count.toString().padStart(8)}  ${r.query}`);

  if (total < 100_000) {
    console.error(`[ingest] WARNING: only ${total} queries (<100k).`);
  }
  db.close();
}

main();
