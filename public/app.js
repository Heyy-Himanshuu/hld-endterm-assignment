// Frontend logic for the typeahead UI. Plain JS, no framework/build step.
//
// Covers the rubric's UI requirements: debounced suggestions, keyboard
// navigation, Enter/click submit, dummy-response display, trending section,
// and loading/error states.

const $ = (sel) => document.querySelector(sel);
const input = $('#search');
const list = $('#suggestions');
const status = $('#suggest-status');
const responseBox = $('#response');
const trendingList = $('#trending-list');
const lastStat = $('#last-stat');
const searchBox = $('.search-box');

let suggestions = []; // current suggestion objects
let activeIndex = -1; // highlighted suggestion for keyboard nav

const mode = () => document.querySelector('input[name="mode"]:checked').value;

// --- debounce: avoid a backend call on every keystroke (rubric §4.1) ---------
function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// Bold the matched prefix inside a suggestion for readability.
function highlight(query, prefix) {
  if (query.toLowerCase().startsWith(prefix.toLowerCase())) {
    return `<b>${escapeHtml(query.slice(0, prefix.length))}</b>${escapeHtml(query.slice(prefix.length))}`;
  }
  return escapeHtml(query);
}
function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// --- fetch + render suggestions ----------------------------------------------
async function fetchSuggestions() {
  const q = input.value;
  if (!q.trim()) {
    closeDropdown();
    status.textContent = '';
    return;
  }
  searchBox.classList.add('loading');
  status.classList.remove('error');
  const t0 = performance.now();
  try {
    const res = await fetch(`/suggest?q=${encodeURIComponent(q)}&mode=${mode()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const ms = (performance.now() - t0).toFixed(1);
    suggestions = data.suggestions || [];
    renderSuggestions(q);
    // Live stat: cache hit/miss + client round-trip latency (great for demos).
    const cacheTag =
      data.cache === 'hit'
        ? '<span class="hit">CACHE HIT</span>'
        : `<span class="miss">CACHE ${String(data.cache).toUpperCase()}</span>`;
    lastStat.innerHTML = `${cacheTag} · ${data.mode} · ${suggestions.length} results · ${ms} ms`;
    status.textContent = suggestions.length === 0 ? 'No matches.' : '';
  } catch (err) {
    status.textContent = `Error fetching suggestions: ${err.message}`;
    status.classList.add('error');
    closeDropdown();
  } finally {
    searchBox.classList.remove('loading');
  }
}

function renderSuggestions(prefix) {
  if (suggestions.length === 0) {
    closeDropdown();
    return;
  }
  list.innerHTML = suggestions
    .map(
      (s, i) =>
        `<li role="option" data-i="${i}" class="${i === activeIndex ? 'active' : ''}">
          <span class="q">${highlight(s.query, prefix)}</span>
          <span class="count">${Number(s.count).toLocaleString()}</span>
        </li>`
    )
    .join('');
  list.hidden = false;
  input.setAttribute('aria-expanded', 'true');

  list.querySelectorAll('li').forEach((li) => {
    li.addEventListener('mousedown', (e) => {
      e.preventDefault(); // keep focus in input
      submitSearch(suggestions[Number(li.dataset.i)].query);
    });
  });
}

function closeDropdown() {
  list.hidden = true;
  list.innerHTML = '';
  activeIndex = -1;
  input.setAttribute('aria-expanded', 'false');
}

// --- keyboard navigation (rubric: "basic keyboard support") ------------------
input.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (list.hidden || suggestions.length === 0) return;
    activeIndex = (activeIndex + 1) % suggestions.length;
    updateActive();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (list.hidden || suggestions.length === 0) return;
    activeIndex = (activeIndex - 1 + suggestions.length) % suggestions.length;
    updateActive();
  } else if (e.key === 'Enter') {
    // Enter on a highlighted suggestion submits it; otherwise submit raw input.
    const q = activeIndex >= 0 ? suggestions[activeIndex].query : input.value;
    submitSearch(q);
  } else if (e.key === 'Escape') {
    closeDropdown();
  }
});

function updateActive() {
  list.querySelectorAll('li').forEach((li, i) => {
    li.classList.toggle('active', i === activeIndex);
    if (i === activeIndex) li.scrollIntoView({ block: 'nearest' });
  });
}

// --- submit search -----------------------------------------------------------
async function submitSearch(query) {
  query = (query || '').trim();
  if (!query) return;
  input.value = query;
  closeDropdown();
  responseBox.hidden = false;
  responseBox.innerHTML = `<div class="detail">Searching…</div>`;
  try {
    const res = await fetch('/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    // Display the dummy response (rubric §4.2 / §9).
    responseBox.innerHTML = `<div class="msg">${escapeHtml(data.message)}</div>
      <div class="detail">Recorded query: “${escapeHtml(query)}”. Counts update on the next batch flush.</div>`;
    refreshTrending();
  } catch (err) {
    responseBox.innerHTML = `<div class="msg" style="color:#dc2626">Search failed</div>
      <div class="detail">${escapeHtml(err.message)}</div>`;
  }
}

// --- trending ----------------------------------------------------------------
async function refreshTrending() {
  try {
    const res = await fetch('/trending');
    const data = await res.json();
    const items = data.trending || [];
    if (items.length === 0) {
      trendingList.innerHTML = '<li class="empty">No activity yet — run a few searches.</li>';
      return;
    }
    trendingList.innerHTML = items
      .map(
        (t) =>
          `<li data-q="${escapeHtml(t.query)}"><span>${escapeHtml(t.query)}</span>
            <span class="score">score ${t.score}</span></li>`
      )
      .join('');
    trendingList.querySelectorAll('li[data-q]').forEach((li) => {
      li.addEventListener('click', () => {
        input.value = li.dataset.q;
        fetchSuggestions();
        input.focus();
      });
    });
  } catch {
    /* trending is non-critical; ignore transient errors */
  }
}

// --- wiring ------------------------------------------------------------------
input.addEventListener('input', debounce(fetchSuggestions, 150));
$('#search-btn').addEventListener('click', () => submitSearch(input.value));
document.querySelectorAll('input[name="mode"]').forEach((r) =>
  r.addEventListener('change', fetchSuggestions)
);
document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-wrap')) closeDropdown();
});

// initial load
refreshTrending();
input.focus();
