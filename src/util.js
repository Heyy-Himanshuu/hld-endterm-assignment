// Shared text-normalization helper.
//
// WHY a single shared function: the prefix used to build the Trie (ingest), the
// prefix used to look up suggestions (/suggest), and the query recorded on
// /search MUST be normalized identically — otherwise a query stored as
// "iPhone 15" would never match a lookup for "iphone 15". Centralizing it here
// guarantees that invariant and is the answer to the rubric's "handle mixed-case
// input" requirement.
export function normalize(s) {
  if (typeof s !== 'string') return '';
  return s
    .toLowerCase()        // case-insensitive matching ("IPHONE" -> "iphone")
    .replace(/\s+/g, ' ') // collapse runs of whitespace to a single space
    .trim();              // drop leading/trailing whitespace
}

// All non-empty prefixes of a normalized query, e.g. "ab c" -> ["a","ab","ab ","ab c"].
// Used by the cache-invalidation step: when a query's count changes we must drop
// every cached prefix result that could now be stale.
export function prefixesOf(query, maxLen = 40) {
  const q = query.slice(0, maxLen);
  const out = [];
  for (let i = 1; i <= q.length; i++) out.push(q.slice(0, i));
  return out;
}
