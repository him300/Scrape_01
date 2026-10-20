# The Monster

*How monster mode is built, file by file, and why each piece exists.*

Monster mode is a **crawl profile**: the manners and the budget of a crawl. The default profile,
`polite`, obeys robots.txt, never executes JavaScript and waits a second between requests.
`monster` ignores robots.txt, renders the page in a local browser first, and works faster with a
much larger budget.

It exists because the polite profile cannot reach a large part of the web: client-rendered apps
(an empty HTML shell), sites that answer plain HTTP with a challenge, and pages whose records live
in embedded JSON rather than in markup.

> **The line.** Monster mode removes politeness. It does not remove restraint.
> Requests stay **sequential per host**, the delay never drops below **100 ms**, and there is **no**
> CAPTCHA solving, ban-evasion or crawler impersonation. Ignoring robots.txt is a deliberate,
> *logged* override of the site's stated wish — the log is the receipt, and the responsibility is
> yours.

---

## The file map

| File | Role in monster mode |
|---|---|
| `src/profile.mjs` | The two profiles and the guardrails. `resolveProfile()` is the single place that decides manners, budget and limits. |
| `src/render.mjs` | Dependency-free Chrome DevTools Protocol driver. Launches a local Chrome/Edge headless and returns the rendered DOM. No npm packages, no bundled browser. |
| `src/net.mjs` | The HTTP client that honours the profile: robots override, browser UA, retries/timeout from the profile, and the render step (with a graceful fallback to raw HTML). |
| `src/agent.mjs` | The "pi" half. Builds the page brief the model plans from, owns the plan → refine → repair → goal-check prompts, and sanitises/verifies every proposal. |
| `src/create-job.mjs` | The shared create flow (CLI + web UI): seed → plan → re-plan → verify → repair → goal check → save → crawl. |
| `src/repair-job.mjs` | The shared repair flow: fetch → ask pi → sanitise → verify on the live page → save → reset the checkpoint. |
| `src/extract.mjs` | The extractors. Gained JS-assigned JSON parsing (`var ytInitialData = {…}`) and `extractPageAuto`, which retries a barren page with other strategies. |
| `src/pipeline.mjs` | The crawl + ingest engine. Profile-aware: delay, retries, timeout, page budget, and the auto-fallback extraction. |
| `src/config.mjs` | Dataset configs may pin `"profile": "monster"`; the profile survives validation and round-trips to disk. |
| `src/server.mjs` / `src/ui.html` | The web surface: a **profile switch** in the masthead, monster switches in the create and run sheets. |
| `src/cli.mjs` | `--monster` on `new` / `run` / `repair`; `scrape01 profile` prints both profiles. |
| `telegram-app/scrape01.mjs` | The Telegram control surface (a Generative App over the CLI). The monster toggle is app state; long jobs run detached with a log file. |
| `tests/monster.test.mjs` | 13 tests: profile resolution, the robots override, embedded-JSON parsing, the auto fallback, the brief's evidence, and the renderer (skipped without a browser). |

---

## 1. The profile contract (`src/profile.mjs`)

```js
POLITE  = { robots: true,  render: false, minDelayMs: 1000, retries: 3, timeoutMs: 30000,
            limits: { maxPages: 200,  maxRows: 200000,  maxDepth: 1 } }
MONSTER = { robots: false, render: true,  minDelayMs: 150,  retries: 6, timeoutMs: 60000,
            limits: { maxPages: 5000, maxRows: 2000000, maxDepth: 6 } }
```

`resolveProfile({ datasetProfile, monster, profileName, overrides })` merges, in order:
the dataset's own profile → the run flag → explicit overrides → the hard floors.

The floors are applied last and cannot be negotiated away:

```js
base.minDelayMs = Math.max(MIN_DELAY_FLOOR_MS, base.minDelayMs);  // 100
base.concurrency = MAX_CONCURRENCY;                                // 1
```

A dataset pins its profile with `"profile": "monster"`; a run can override it with `--monster`.

## 2. Rendering (`src/render.mjs`)

Node 22 ships a global `WebSocket`, so the browser is driven directly — no Puppeteer, no
dependency, no download:

```
findBrowser()  →  spawn(edge|chrome, --headless=new --remote-debugging-port=N --user-data-dir=…)
                →  poll /json/version for the devtools endpoint
                →  Cdp.connect(ws) → Target.createTarget → Target.attachToTarget(flatten)
                →  Page.enable + Network.enable + Network.setUserAgentOverride
                →  Page.navigate → wait for Page.loadEventFired → settle (profile.settleMs)
                →  Runtime.evaluate("document.documentElement.outerHTML")
```

The rendered HTML is cached like any other response, and the raw HTML is kept when the render
returns nothing new. If no browser is installed, the client logs a warning and falls back to raw
HTML — a missing browser degrades the mode, it never breaks the crawl.

## 3. The create flow (`src/create-job.mjs`)

```
seed page ──► pi plans an extractor
                  │
                  ├─ the plan may target ANOTHER page (a search page, a listing page)
                  │     └──► re-plan against that page, now with its real structure
                  │
                  ▼
             verify on the live page   (≥2 real declared data columns)
                  │
        ┌─────────┴─────────┐
      fails              passes
        │                   │
   pi repairs (×2)     goal check: do these rows answer the request?
        │                   │
        ▼            ┌──────┴──────┐
   nothing written  no             yes
                   │                │
              pi repairs ──► re-check ──► save + crawl
```

Two rules make this more than a one-shot guess:

* **The plan's URL is the plan.** The model's chosen source URL is kept; the tool fetches *that*
  page and re-plans against it. Clobbering it with the seed URL is how a correct extractor dies.
* **Rows are not enough.** A separate goal-check call asks pi whether the sample row actually
  answers the request. On YouTube this is the difference between "20 rows" and "the subscriber
  count is in the wrong column".

Three more, added after the same site produced 25 rows in one run and 5 in the next:

* **The listing must be followed to its end.** The plan's pagination is checked against the
  *page*: if the page offers a next link and the plan does not follow it, the pagination is
  derived in code and written into the config. A dataset that holds only page 1 is not the
  dataset, and the tool refuses to pretend otherwise.
* **The type follows the data.** A page that says "July 1, 2025" offers a *day*. Typing that
  column `datetime` printed a time of day that was never scraped (and shifted the calendar date
  in a non-UTC zone: "Oct 20, 2026" became "2026-10-19T22:00:00.000Z"). The type is measured
  from the values — `date` for a calendar date, `datetime` only when a time of day is really
  there. The same source then yields the same shape in polite mode and in monster mode.
* **No invented rows.** A page that yields no records is reported as such. The `meta` strategy
  is never a fallback: it reads the *page's* metadata, and recovering with it turned a 25-row
  dataset into 26 with a fabricated row.

Nothing is written until the extractor has produced real rows *and* the goal check passes.

## 4. The evidence pi plans from (`src/agent.mjs`)

A model cannot fix a field mapping it cannot see. `htmlBrief()` gives pi the page's structure:

| Section | What it carries |
|---|---|
| `ELEMENT IDS` | `id × count — sample text`. The sample text is what reveals that `#video-count` holds *"16 subscribers"*. |
| `REPEATED CLASSES` | The most common `tag.class` pairs **with their sample text** — the sample is what tells `.meta-data-font` ("July 1, 2025") from `.text-block-9` ("•"). Without it the model guesses, and the same page produced a date in one run and a bullet in the next. |
| `RECORD ANATOMY` | The skeleton of the repeating card (ids, classes, hrefs, **machine-readable attributes**, texts), boosted toward whatever the goal mentions. Falls back to class-based cards when the page has no ids at all (Webflow, Shopify). |
| `PAGINATION` | Whether the listing CONTINUES, and the next-page link. A plan that ignores this captures only the first page — the difference between 25 rows and 5. |
| `CANDIDATE RECORD ARRAYS` | Where the records actually live inside an embedded JSON payload, with the leaf field names *and their values*. |
| `JSON OUTLINE`, `CUSTOM ELEMENTS`, `LINKS`, `HEADINGS`, `BODY TEXT` | The rest of the map. |

The JSON path must end at an **array of records**; when that array mixes item kinds, the per-item
key belongs in the *field* path (`$.channelRenderer.title.simpleText`).

## 5. Extraction (`src/extract.mjs`)

* `parseEmbeddedPayload(text, varName)` reads pure JSON *and* JS assignments
  (`var ytInitialData = {…}`, `window.__DATA__ = {…}`) by slicing a balanced object literal.
* `extractPageAuto()` runs the declared extractor, and if it matches nothing, retries the page
  with the other strategies (`json` → `jsonld` → `table` → `meta`) and reports which one won.
* The pipeline drops records whose data columns are **all** empty — a barren row is not a row.

## 6. The surfaces

```bash
scrape01 serve                       # web UI: the PROFILE switch in the masthead is the toggle
scrape01 new x --url https://… --monster
scrape01 run x --monster
scrape01 repair x main --monster
scrape01 profile                     # print both profiles
```

In the web UI the switch sets the default profile for new actions in that browser
(`localStorage`), and each dataset keeps its own profile. In Telegram the `scrape01` app carries the
same toggle in its state; its buttons are bound methods, so they bypass the model entirely.

---

## Proven

The case that started all of this — a YouTube subscriber count, the hardest kind of target:

```bash
scrape01 new subs3 --url https://www.youtube.com/ \
  --goal "subscriber count of the YouTube channel Morphic Labs" --monster
```

* the seed page is an app shell → the search page is rendered in the local browser
* pi plans against the real page, the plan points at `/results`, the tool re-plans against it
* the extractor is verified on the live page (20 rows)
* the goal check catches YouTube's swapped fields (`subscriberCountText` holds the `@handle`,
  `videoCountText` holds the count) → pi repairs → the goal check passes

`data/subs3/subs3.csv`:

```
Morphic Labs,151 subscribers,,UCyneLBIDsMZOzcwup90sJQw,https://www.youtube.com/@Morphic_Labs
Morphic Lab,1.85K subscribers,,UCf4mp9akiVsC2BhUiO97RFQ,https://www.youtube.com/@MorphicLab1
```

151 subscribers — the same number `youtube_scrape` reports for `@Morphic_Labs`.

### The consistency case (2026-10-21)

`https://www.math3ma.com/` — a 25-post blog across 6 pages — produced **25 rows in one create and
5 in the next**. The cause was not the site; it was three unchecked assumptions:

| assumption | what was actually true | the fix |
|---|---|---|
| the plan paginates | the plan had no `paginate` at all | the plan is checked against the page; a missing pagination is derived in code and written back to the config |
| the date column is a timestamp | the page says "July 1, 2025" — a DAY | the type follows the data: `date` unless a time of day is really there |
| a page with no rows is a row | the `meta` fallback invented a 26th row from `og:title` | `meta` is never a fallback; barren pages are reported, not filled |

After the fix, five creates of the same site all produce **25 rows, 0 rejected, 0 drift**, with
the dates as calendar dates (`2025-07-01`, `2025-02-01`, `2023-03-28`), and a re-run adds 0 rows
and 25 duplicates instead of replacing the dataset with 5. The one page that yields no records
(the `/blog/whats-next` archive, a different layout) is reported as such:

```
warn  no records on this page  source=main page=6 url=…/blog/whats-next
      note=the declared extractor matched nothing here — this page has a different layout (no rows were invented)
info  dataset done  dataset=mathm newRows=25 totalRows=25 pages=6 drift=0 stoppedEarly=0 paginationFixed=0 pagesWithoutRecords=1
```

**Lesson:** the same source must produce the same dataset in every run, in every profile. The
places that broke that were all places where the tool ASSUMED something it had not measured —
the pagination, the column type, and the "there must be a row here".

## Known limits

* Rendering needs a local Chrome/Edge/Chromium. Without one, monster mode degrades to raw HTML.
* The renderer makes JavaScript apps legible. It does not solve CAPTCHAs, fingerprint defences or bans.
* `sp=EgIQAg%3D%3D` (YouTube's channel filter) is what turns a mixed result page into a channel
  list; a double-encoded `%253D` parameter is silently ignored by the site.
* A create costs several model calls (plan → re-plan → repairs → goal check). That is the price of
  "the right data" rather than "some data".

---

## The capability ledger (measured, not asserted)

Every row below was verified on 2026-10-20 — the robots rules parsed with the tool's own parser,
the same URLs fetched under every profile, the logs audited, and 40 probe requests for reliability.

### It can

| | |
|---|---|
| **Fetch** | plain HTTP (honest or browser UA); on a transport failure it retries once with the honest UA, then (monster) hands the page to a real headless Chrome/Edge over CDP |
| **Extract** | HTML tables · CSS selectors · JSON-LD · embedded JSON (script tags *and* `var X = {…}`) · **raw JSON endpoints** (the body IS the payload) · **parallel arrays zipped by index** (`{"json":path,"indexed":true}`, `"$#path"`, `as:"iso"`) · meta · regex |
| **Navigate** | next link · page numbers / url templates · offset · cursor. A next-page link the plan missed is detected **in the page** and followed (and written back to the config), so a listing is never silently truncated at page 1 |
| **Plan** | pi reads a distilled brief (element ids *with sample text*, class histogram *with sample text*, record anatomy, **pagination**, JSON outline, candidate record arrays) → the plan is verified on the live page → repaired up to twice → a goal check that sees the data's **shape** (rows, window, modal gap, distinct minute-of-hour) and whether the listing continues → **nothing is written if the goal is unmet** |
| **Order** | ingest order by default; `sortBy` settable (CLI / UI / API); the create flow proposes ascending for time series |
| **Dates** | the column type follows the data: `date` for a calendar date, `datetime` only when a time of day is really there. A display date is never printed as a fabricated midnight, and the calendar day is never shifted by the machine's timezone |
| **Verify** | content hash + header lock (`scrape01 verify`); `dropAllZero` for placeholder rows; an optional column that cannot be coerced loses the cell, not the row; a page that yields no records is reported, never filled in |

### It cannot

| | |
|---|---|
| **Log in** | no cookie jar, no credential store, no re-login, no 2FA. Static `sources[].headers` only — and `writeDatasetFile` does not persist them (known gap) |
| **Defeat a gate** | no CAPTCHA/Turnstile solving, no ban evasion, no fingerprint spoofing, no crawler impersonation. It may *disobey a robots rule* when you ask for monster mode — and it logs that, every time |
| **Crawl a graph** | one source → its pagination chain. No link-graph traversal, no sitemap expansion, no concurrency (sequential per host, 100 ms floor) |
| **Get data the site doesn't serve** | provider ceilings are the provider's, not the tool's. Yahoo: **1m = 8 days/request · 2m–90m = 60 days · 1h = 730 days · 1d/1wk/1mo = unlimited**. Yahoo's *page* route serves **daily bars only** — the intraday bars exist only behind the machine API, whose host is `Disallow: /` |
| **Render without a browser** | JS rendering needs a local Chrome/Edge/Chromium; without one, monster degrades to raw HTML with a warning |

### The user agent is a hidden variable

Yahoo's two hosts want **opposite** user agents — measured, 5 requests each:

| target | honest `scrape-01/1.0 (+polite)` | browser `Mozilla/5.0 … Chrome/131` |
|---|---|---|
| `finance.yahoo.com/quote/…/history/` | **5/5 OK (3.0 MB)** | 0/5 — `UND_ERR_HEADERS_OVERFLOW` |
| `query1.finance.yahoo.com/v8/finance/chart` | OK (1.13 MB) | 5/5 OK |

The browser UA makes the page edge answer with a consent/redirect chain whose headers exceed
undici's 16 KB limit. So the client **retries with the honest UA** when a transport error looks
like that (`stats.uaFallback`) — and never the other way round: a polite run keeps its honest
identity for ever, and the tool never pretends to be a browser in the direction that lies.

### Which mode, when

| you are… | use |
|---|---|
| repeating, bulk, or publishing | `--respect-robots`: you keep the rendering and the speed, and you leave the host's wishes intact |
| pulling once, for yourself | monster's override is defensible — it is logged per host, every time |
| a site whose *page* is enough | plain `polite`; the honest UA reads most pages fine |

---

## Time series are ordered by their time axis (strict rules)

A time series is a property of the **values**, not of the declared type. `src/timeorder.mjs`
detects the time axis from the data and records *how* it was interpreted, so a sort can never
silently change meaning between crawls.

### The detection ladder

`iso` → `epochMillis` → `epochSeconds` → `epochMicros` → `yearMonth` → `year` → `dayFirst` →
`monthFirst` → `parsed`. The first interpretation that explains **≥ 95 %** of a 200-value sample
wins.

### The strict rules

| rule | why |
|---|---|
| **Detect by value, not by type** | a `string` column of `"Oct 20, 2026"` is a time series; so is a `number` column of epoch seconds |
| **Ambiguity is refused** | `20/10/2026` is 20 October *or* 20 March, and `Date.parse` silently picks the US reading. `dayFirst` is accepted only if some value has a first component > 12; `monthFirst` only if some value has a second component > 12; if neither, **no order is declared** and you are told why |
| **`parsed` must look like a date** | `Date.parse("3.10")` is a time today and `Date.parse("0")` is a date in 2000 — so a bare number is never a date, and a 4-digit year is required |
| **`year` must be a string** | a *number* that looks like a year is far more likely a price |
| **A constant column is not a time series** | no order is declared for a column whose value never changes |
| **One time column** | the declared key wins if it is time-like; otherwise the time-like column with the most distinct values. The runners-up are reported |
| **The interpretation is recorded** | `"timeKinds": {"when": "dayFirst"}` in the config, and `sortedBy`/`timeKinds` in the manifest — the order can never quietly change meaning |
| **Only the projection is ordered** | the raw log keeps ingest order; the CSV is the projection. `scrape01 sort <ds> --reset` returns to the page's order |

### Where it applies

* **The create flow proposes the order** from the detected axis — the goal's wording no longer
  decides it. The exception: a goal that asks for "the latest / most recent / top N" keeps the
  page's order, because that order *is* the answer.
* **`scrape01 sort <ds> <col>[:asc|:desc]`** detects the kind and records it.
* **The dashboard's order sheet** marks the time-axis columns and their interpretation.
* **`orderRows`** compares by real instants when a kind is recorded, so `"Jan 05, 2026"` sorts
  before `"Oct 20, 2026"` instead of alphabetically.

---

## When the page does not have the data (the failure that cost three runs)

A goal can fail for three completely different reasons, and the repair must match the fault.
The create flow now asks the goal check to **name whose fault it is** and routes accordingly.

| fault | meaning | the tool's move |
|---|---|---|
| **source** | the page does not serve the data: an error row (*"There are no data in the selected time period"*), an app shell, a login wall, or **the wrong granularity** (daily bars when the request asked for hourly ones) | ask pi for a **different URL** (another page, or the JSON endpoint behind it), fetch it, re-plan against it, re-verify. No extractor can fix this. |
| **extractor** | the data is there but mis-mapped (the count in the wrong column, a value empty, field names off) | repair the extractor (up to two rounds), then re-check the goal |
| **goal** | the request itself cannot be satisfied by this site | fail plainly — no amount of scraping helps |

`classifyExtraction()` (in `agent.mjs`) also recognises the error state *structurally*, without
asking the model: a handful of rows that are nearly empty next to a wider table, or a long
"no data" message. The DATA SHAPE block the goal check reads now says which of the three it is
looking at, and includes the measured **granularity** (the modal gap and the distinct
minute-of-hour count) — which is what let it say *"252 daily bars, not 1-hour bars"* on its own.

**Proven:** the DJ request (hourly Dow Jones bars) failed three times before this. It now fails
fast with a precise diagnosis, and when the page serves the *wrong granularity* the tool switches
to the endpoint that serves the right one and finishes the job — 1,755 hourly bars, verified.

---

## Monster mode, revised: capable, not evasive

Monster mode used to *always* drive a browser, and to hit every URL on an exact 150 ms metronome.
Both were wrong: the browser was paid for on every page (even when the raw HTML already held the
data), and an exact interval is a **signature** — the shape of a machine, which is precisely what a
learned per-site baseline spots.

### The browser is a fallback, not the default

```
raw HTML  ──►  rows?  ──yes──►  use it          (no browser, no extra load on the site)
                │
                no
                ▼
           render in Edge  ──►  rows?  ──yes──►  use it
                                    │
                                    no
                                    ▼
                          try the other strategies
                          (json → jsonld → table → meta)
```

Measured on Yahoo's history page:

| | time | bytes |
|---|---|---|
| raw | **4.8 s** | 3.07 MB (and the browser's DOM was *smaller* — 2.31 MB) |
| rendered | 17.8 s | 2.31 MB |

A full re-crawl of the 12,348-row hourly dataset went from ~17 s per page to **2.2 s for the
whole dataset** — and the site never saw a browser.

### The pacing is no longer a metronome

`jitter: {min: 60, max: 320}` on every request, plus a "thinking" pause every 25 requests
(700–2,400 ms). Measured gaps on a live five-request crawl: **705, 492, 346, 345, 465 ms** —
before it was 150, 150, 150, 150, 150. The floor (100 ms) and the sequential rule are unchanged.

### What monster mode still refuses to do

* no fingerprint spoofing (canvas, WebGL, TLS, HTTP/2) to defeat a bot-management decision
* no CAPTCHA or challenge solving
* no proxy rotation to dodge an IP ban (Cloudflare ships residential-proxy detection as its own
  family — a proxy swaps IP exposure for a different tell)
* no impersonating a human being

The goal is not to be invisible. It is to be **ordinary**: to look like a client a site's own
baseline would not flag, to cost the site as little as possible, and to take only what is served
without a gate.
