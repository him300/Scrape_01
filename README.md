# Scrape_01

A durable, self-healing scraper that turns the web into **ordered CSV datasets**.

Two halves, deliberately separated:

- **The engine** (deterministic, zero dependencies): fetch → extract → coerce → append → project to CSV.
- **`pi`** (the agent): designs an extractor from a live page, and repairs it when a site changes
  shape. Agent output is *never* trusted — every proposal is executed against the real page and
  inspected before it can touch a config.

The design bet: durability is not "run it in a loop". Durability is *every failure mode having a
defined recovery*, and *the CSV never being the only copy of anything*.

---

## Quick start

```bash
cd Scrape_01
node bin/scrape01.mjs init .                       # create datasets/ data/ .scrape01/

# let pi design a dataset from a live page (verified before anything is written)
node bin/scrape01.mjs new quotes --url https://quotes.toscrape.com/ --goal "quote, author, tags"

node bin/scrape01.mjs run quotes                   # crawl, ingest, write CSV
node bin/scrape01.mjs csv quotes --limit 5         # look at it
node bin/scrape01.mjs status                       # rows, checkpoints, last run
```

The **durable** mode:

```bash
node bin/scrape01.mjs loop --all --interval 6h --auto-repair
```

`loop` runs forever, one pass at a time, reloading configs each pass (so a repair takes effect
without a restart), backing off exponentially when every dataset fails, and writing one line of
history per pass to `.scrape01/history.jsonl`. `Ctrl-C` finishes the current pass before exiting.

For a machine that reboots, register it with the OS:

```bash
node bin/scrape01.mjs schedule install --interval 30m    # Windows schtasks; prints a cron line elsewhere
node bin/scrape01.mjs schedule show
```

### The dashboard (CSV control surface)

```bash
scrape01 serve            # or: scrape01 serve --open  /  --port 8787
#  -> http://127.0.0.1:8787
```

A local web UI over the same engine — no build step, no framework, no extra dependencies:

- **Datasets** sidebar: rows, columns, size, last run, `done` / `partial` / `drift` at a glance.
- **Profile switch** in the masthead: `polite` / `monster` — the default for every new action in
  this browser (remembered in `localStorage`). Each dataset keeps its own profile.
- **Grid**: 12 columns, 8 px baseline, one source of truth in `:root`. Press **G** to see the
  guides the page is actually built on; the overlay lives in the same content box as the content,
  so it cannot drift.
- **Data**: the CSV itself, with numeric-aware column sorting, row filtering, page sizes, and
  click-to-copy cells; downloads the *exact* on-disk file (`/download` serves the same bytes).
- **Sources**: per-source checkpoint, ingest count, drift state, and a **Repair with pi** button.
- **Activity**: every job with its status and result.
- **Controls**: `Run` (resume from checkpoint), `Run with options…` (max pages, delay, force,
  dry-run), `Rebuild CSV`, `Verify`, `Repair`, and **`+ new`** — paste a URL, say what you want,
  and pi designs + verifies a dataset, then crawls it.
- **Live log drawer**: the run's structured log streamed over SSE as it happens.

Two rules the UI inherits from the engine rather than re-implementing:

1. **One writer at a time.** All actions become jobs in a single in-process queue; a second
   action while one is running is refused with `429`, never interleaved. A lock file still guards
   against another process.
2. **The UI cannot invent data.** It only calls engine functions — same validation, same
   verification, same atomic CSV write. `Run` is resumable, so clicking it twice is harmless.

Bound to `127.0.0.1` with no authentication (it is a local tool); `--host 0.0.0.0` is possible and
prints a warning.

---

## Layout

```
datasets/<name>.json        THE SCHEMA: declared column order + extractors  (source of truth for shape)
data/<name>/raw.jsonl       append-only ingest log  (source of truth for data)
data/<name>/<name>.csv      derived, ordered CSV  (a pure function of raw.jsonl + schema)
data/<name>/rejects.jsonl   rows that failed validation, with the reason
data/<name>/state.json      per-source checkpoint: page cursor, next url, drift flag
data/<name>/manifest.json   header lock + content hash + row count
data/<name>/.lock           single-writer lock (pid + host + timestamp)
.scrape01/cache/                HTTP cache (ETag / Last-Modified revalidation)
.scrape01/logs/run-YYYY-MM-DD.jsonl   structured run log
.scrape01/history.jsonl         one record per loop pass
.scrape01/agent/                last agent request/response (audit trail for every pi call)
```

---

## What "ordered" means here — precisely

Four separate guarantees, each enforced mechanically:

1. **Column order** comes only from `columns[]` in the dataset config. It is never inferred from
   data. `manifest.json` stores `headerHash` (a hash of the column names *in order*), so a schema
   change is visible rather than silent.
2. **Row order** is ingest order (`_ord`, a monotonic counter) unless the dataset declares
   `sortBy` (e.g. `"price:desc"`), in which case ties still break on `_ord`.
3. **Rebuild is byte-identical.** The CSV is a pure function of `raw.jsonl` + schema, with fixed
   RFC4180 quoting and CRLF/LF from config. Running `scrape01 rebuild` twice produces the same bytes —
   verified by the test suite.
4. **Duplicates cannot accumulate.** Each row's `_key` is a hash of the declared `key` columns; the
   first occurrence wins. Re-crawling, resuming, or losing `state.json` never duplicates rows.

---

## Durability: every failure mode has an answer

| Failure | Behaviour |
|---|---|
| Process killed mid-crawl | Rows are `fsync`-appended **before** the checkpoint advances. Restart resumes at the last committed page. A torn trailing JSON line is detected and truncated on next read. |
| Two runs at once | `.lock` (pid + host). A stale lock (dead pid, or older than 6h) is reclaimed automatically; a live one makes the second run skip with a clear message. |
| Site changes its markup | The page fetches fine but extracts 0 valid rows → the source is flagged `drift`, logged loudly, and the run reports it instead of silently writing an empty CSV. `scrape01 repair` (or `--auto-repair`) asks pi for a new extractor and verifies it on the live page. |
| Bad rows | Type coercion failures (e.g. `price: "N/A"`) go to `rejects.jsonl` with the reason; they never corrupt the dataset. |
| Network flake / rate limits | Retries with exponential backoff, `Retry-After` honoured, per-host delay, robots.txt obeyed (including `Crawl-delay`), conditional GETs so re-crawls are cheap. |
| Partial CSV write | CSV is written to a temp file, `fsync`ed, then atomically renamed. |
| Schema drifted from the file on disk | `scrape01 verify` checks header, row count, and content hash against the manifest. |

---

## Dataset config

```json
{
  "name": "books",
  "columns": [
    { "name": "title", "type": "string", "required": true },
    { "name": "price", "type": "number" },
    { "name": "in_stock", "type": "bool" },
    { "name": "url", "type": "url" },
    { "name": "scraped_at", "type": "datetime" }
  ],
  "key": ["url"],
  "sortBy": null,
  "sources": [
    {
      "id": "catalogue",
      "url": "https://books.toscrape.com/catalogue/page-1.html",
      "extract": {
        "kind": "selector",
        "row": "article.product_pod",
        "fields": {
          "title": { "selector": "h3 a", "attr": "title" },
          "price": ".price_color",
          "in_stock": ".availability",
          "url": { "selector": "h3 a", "attr": "href" }
        }
      },
      "paginate": { "mode": "next", "selector": "li.next a", "max": 50 }
    }
  ],
  "csv": { "delimiter": ",", "newline": "\r\n" }
}
```

Column types: `string`, `number`, `integer`, `bool`, `url`, `datetime`, `enum` (with `values`).
`number` understands `$1,234.50`, `1.234,50`, `(42)`; `bool` understands `In stock` / `Out of stock`.

Provenance columns `source`, `url`, `page`, `scraped_at`, `rank` are filled by the engine when the
extractor leaves them blank — so every row is traceable to where it came from.

### Extractors

| kind | config |
|---|---|
| `table` | `table` (css), `headerMap` (header text → column), `cellFields` (column → `"a@href"`) |
| `selector` | `row` (css), `fields` (column → field spec) |
| `jsonld` | `types`, `listPath`, `fields` (column → `$.dotted.path`) |
| `json` | `scriptSelector` / `__NEXT_DATA__`, `path`, `fields` |
| `meta` | `fields` (column → `$.metaName` / `$.title` / `$.canonical`) |
| `regex` | `pattern`, `flags`, `groups` (column → group number) |

Field specs: `"css"` (text), `"css@attr"`, `{"selector","attr"}`,
`{"selector","all":true,"join":" | "}`, `{"selector","attr":"class","regex":"star-rating (\\w+)"}`.

### Pagination

`{"mode":"next","selector":"li.next a"}`, `{"mode":"pageNumbers","urlTemplate":"...?page={page}","max":20}`,
`{"mode":"offset","urlTemplate":"...?offset={offset}","step":50,"max":1000}`,
`{"mode":"cursor","selector":"[data-cursor]","attr":"data-cursor","urlTemplate":"...?after={cursor}"}`.

---

## Commands

| Command | Purpose |
|---|---|
| `scrape01 init [dir]` | create the workspace |
| `scrape01 doctor` | environment, configs, checkpoints, network, pi availability |
| `scrape01 new <name> --url <u> [--goal "..."]` | pi designs a config; verified on the live page before saving |
| `scrape01 plan <url>` | print pi's proposal, write nothing |
| `scrape01 profile [name]` | show the crawl profiles (polite / monster) |
| `scrape01 run [dataset...]` | crawl + ingest + write CSV (resumable, idempotent) |
| `scrape01 loop` | durable mode: forever, interval, backoff, history |
| `scrape01 serve [--port N] [--open]` | web dashboard: browse CSVs, run, repair, scrape new URLs |
| `scrape01 repair <dataset> <source>` | pi rewrites a drifted extractor, verified then checkpoint-reset |
| `scrape01 rebuild [dataset...]` | regenerate CSV from `raw.jsonl`, no network |
| `scrape01 delete <dataset>` | remove a dataset and everything it produced (asks first) |
| `scrape01 status` / `scrape01 verify` / `scrape01 csv` / `scrape01 history` | inspect |
| `scrape01 schedule install\|remove\|show` | OS scheduler (schtasks / cron hint) |
| `scrape01` (npm) | `npm link` in this folder exposes `scrape01` on PATH (package name `scrape-01`) |

Useful flags: `--all`, `--force` (re-crawl completed sources), `--dry-run`, `--max-pages N`,
`--cache-ttl s`, `--delay ms`, `--auto-repair`, `--continue`, `--model <id>`, `--debug`,
`--monster` (see Crawl profiles).

---

## Crawl profiles: polite vs monster

A profile is the crawl's manners and budget. Two exist.

| | `polite` (default) | `monster` |
|---|---|---|
| robots.txt | obeyed — a disallowed URL is never fetched | ignored, and every host it skips is logged |
| JavaScript | not executed | rendered in a local Chrome/Edge (CDP, no npm dependency) |
| delay per request | 1 s | 150 ms (hard floor: 100 ms) |
| retries / timeout | 3 / 30 s | 6 / 60 s |
| page budget | 200 | 5000 |
| user agent | `scrape-01/1.0 (…polite)` | a normal browser UA |

Turn it on per run, per dataset, or per job in the dashboard:

```bash
scrape01 run mydata --monster
scrape01 new mydata --url https://… --monster
```

```json
{ "name": "mydata", "profile": "monster", "columns": [], "sources": [] }
```

**What monster mode is for:** JavaScript apps (the HTML you get is an empty shell), sites that
block plain HTTP, and pages whose records live in embedded JSON (`var ytInitialData = {…}`).
The `json` extractor now reads those JS-assigned payloads, and if a declared extractor matches
nothing, the engine retries the page with the other strategies before calling it barren.

**What monster mode is not:** it does not defeat CAPTCHAs, fingerprint defences or bans, and it
does not impersonate crawlers. Requests stay sequential per host and never drop below 100 ms —
aggressive, not a flood. Ignoring robots.txt is a deliberate override of the site's stated wish;
it is logged every time it happens, so the log is the receipt.

### The create flow, end to end

```
seed page ──► pi plans an extractor ──► the plan may target ANOTHER page
                                            │
                                            ▼
                                     re-plan against that page (with its real structure)
                                            │
                                            ▼
                                 verify on the live page (≥2 declared data columns)
                                            │
                          ┌─────────────────┴─────────────────┐
                       fails                              passes
                          │                                   │
                 pi repairs (twice)                  goal check: do the rows answer the request?
                          │                                   │
                          ▼                          ┌────────┴────────┐
                  still empty → nothing written     no                yes
                                                     │                 │
                                            pi repairs → re-check   save + crawl
```

Nothing is written until an extractor has produced real rows *and* a second opinion says the
rows answer the goal. A page that yields rows but the wrong rows is treated as a failure.

**The full map of monster mode — every file, the logic, the guardrails and the proven example —
is in [`docs/MONSTER.md`](docs/MONSTER.md).**

---

## The self-repair loop

```
run ──► 0 rows from a reachable page ──► drift flagged (state + log + summary)
                        │
                        ▼
              scrape01 repair <dataset> <source>
                        │   pi reads a distilled view of the page (tables, JSON-LD, headings,
                        │   links, body text) — not the raw HTML
                        ▼
                 proposal ──► sanitize (drop empty specs, wrong-shaped maps, undeclared fields)
                        │
                        ▼
                 verify on the LIVE page (must yield ≥2 declared data columns)
                        │
              ┌─────────┴─────────┐
            reject              accept
        (nothing written)   write config + reset that source's checkpoint
                                  │
                                  ▼
                        next run re-crawls; existing rows dedupe
```

Every agent call is recorded in `.scrape01/agent/last-request.txt` and `last-response.txt`, so a repair
is auditable after the fact.

---

## Tests

```bash
node --test            # 26 tests, no network, no dependencies
```

`tests/engine.test.mjs` (17) — HTML parser and selector engine (nested tables, entities,
`:nth-child`, `:not`, quoted attribute values), RFC4180 round-tripping, type coercion, schema
validation, full pipeline runs against a local fixture server (pagination, dedupe, resume,
per-run page budget,
provenance fill, robots.txt refusal, drift detection), torn-line crash recovery, lock contention
and stale-lock reclaim, deterministic rebuild + manifest verification, and the agent proposal
sanitiser/verifier.

`tests/server.test.mjs` (9) — the dashboard's contract against a real fixture site on an
ephemeral port: shell serves, summary reports checkpoints and the header lock, row paging/filtering
sorts numerically (not lexicographically), `/download` is byte-identical to the on-disk CSV, verify +
rebuild jobs complete, a run captures structured log lines and resumes from the checkpoint without
duplicating, a second action is refused with 429 while one runs, SSE emits `snapshot` then `status`,
and traversal / bad URLs / unknown datasets are rejected.

---

## Known limits (honest ones)

- **JSON only** for configs — no YAML parser is shipped, on purpose (no dependency).
- **JavaScript rendering needs a local browser.** The `monster` profile drives Chrome/Edge/Chromium
  over the DevTools Protocol (no npm dependency, no bundled browser). Without one, it falls back to
  raw HTML and says so in the log. The renderer does not solve CAPTCHAs or bot defences.
- **Linear crawling only** (one source → its pagination chain). No link-graph traversal, and no
  concurrency across a host — even in monster mode, requests stay sequential per host.
- `raw.jsonl` is **streamed**, not read whole: the log and the CSV are both processed line by line
  (a JavaScript string cannot exceed 512 MB, so a 5 M-row log used to read as **zero rows** — silently).
  Measured on a 7.3 GB box: 1 M rows in ~2 s, **5 M in 24 s, 10 M in 48 s, 20 M in 97 s**
  (peak RSS 0.9 → 3.1 GB; 20 M rows = a 4.1 GB log + a 580 MB CSV).
  Two caveats: a dataset that declares a `sortBy` must be **held in memory to sort** (≈5–8 M rows on
  that box), and the dedupe set holds one key hash per row. `limits.maxRows` is advisory — it is
  reported in the log when exceeded, not enforced.
- Dedupe is keyed on declared columns; a site that mutates a key column will produce new rows.
- `robots.txt` is honoured by default. `--monster` (or `"profile": "monster"`) overrides that —
  every skipped rule is logged, but the override is real and the responsibility is yours.
- The goal check costs one extra model call per create; it is the difference between "scraped
  something" and "scraped the right thing", but it is not free.
