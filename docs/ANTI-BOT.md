# How scrapers get stopped, and what exposes you

*Researched 2026-10-20. Sources: Cloudflare Bots/Challenges docs, DataDome docs, HUMAN docs,
W3C Fingerprinting Guidance, MDN, RFC 9309, Turnstile/reCAPTCHA docs, CourtListener.
The "your exposure" column is **measured** against this machine (tls.peet.ws), not quoted.*

---

## 0. What your machine actually looks like from the other side

| | polite fetch (raw HTTP) | monster fetch (rendered in Edge) |
|---|---|---|
| IP seen | `41.193.168.122:13731` | `41.193.168.122:13760` — **your residential IP either way** |
| User-Agent | `scrape-01/1.0 (+local dataset builder; polite)` | `Mozilla/5.0 (Windows NT 10.0; Win64; x64) … Chrome/131.0.0.0 Safari/537.36` (no "Headless") |
| TLS (JA4) | `t13d5213h1_b262b3658495_66863fb0a24c` (Node/undici) | `t13d1516h2_8daaf6152771_806a8c22fdea` (real Chrome) |
| HTTP/2 fingerprint | *none sent* | `1:65536;2:0;4:6291456;6:262144\|15663105\|0\|m,a,s,p` (Chrome's) |
| Client hints | none | `sec-ch-ua`, `sec-ch-ua-mobile`, `sec-ch-ua-platform` |
| Fetch metadata | none | `sec-fetch-site: none`, `sec-fetch-mode: navigate`, `sec-fetch-dest: document` |
| Cookies | none, ever | per-render-session only (a fresh temp profile each time) |

**The two conclusions that matter:**

1. **The raw path is a neon sign.** No HTTP/2 fingerprint, no client hints, a JA4 that belongs to
   Node, and a self-identifying UA. Any classifier sees "script" instantly.
2. **The rendered path is nearly indistinguishable from Chrome at the network layer** — same TLS
   stack, same HTTP/2 SETTINGS, same hints. What still gives it away is *in-page*: `navigator.
   webdriver === true`, and a request pattern with no favicon, no assets, no scrolling.

---

## 1. Ways a scraper gets stopped (the technical list)

| # | Mechanism | What the site inspects | How it stops you | Your tool's position |
|---|---|---|---|---|
| 1 | **robots.txt** (RFC 9309) | the file | voluntary — Cloudflare: *"robots.txt compliance is voluntary… some crawler operators may disregard your robots.txt directives"* | polite obeys; monster overrides **and logs it** |
| 2 | **Managed robots.txt at the edge** | your UA vs their policy | Cloudflare can *enforce* it in the WAF for AI/search crawlers | monster's override is exactly what this is aimed at |
| 3 | **Rate limiting** | requests/IP/token bucket | 429 + `Retry-After`, then a longer block | 150 ms floor + sequential = ~6 rps; a burst would trip it |
| 4 | **JS challenge** (Cloudflare "Under Attack", Turnstile) | proof-of-work, proof-of-space, web-API probing, browser quirks, human behaviour | interstitial, then a clearance cookie | a real browser *can* pass it — the rendered path does |
| 5 | **Scored challenge** (reCAPTCHA v3, Turnstile score) | a 0.0–1.0 risk score | below threshold → 403, no page | no solving; the rendered path just doesn't run the widget |
| 6 | **Managed challenge / block page** | everything above | 403 + a "verify you are human" page | the rendered path is the best you can do |
| 7 | **TLS fingerprinting (JA3/JA4)** | the ClientHello | Cloudflare exposes `cf.bot_management.ja3_hash` and `cf.bot_management.ja4`; a non-Chrome JA4 is a strong signal | raw = Node's JA4 (obviously a script); rendered = Chrome's JA4 (indistinguishable) |
| 8 | **HTTP/2 fingerprinting** | SETTINGS frame, window update, pseudo-header order, header order | Akamai's fingerprint is what a site compares | raw = no h2 fingerprint at all; rendered = Chrome's exact one |
| 9 | **Header consistency** | UA vs `sec-ch-ua` vs platform vs accept headers | mismatch = "spoofed UA" | the rendered path is internally consistent; the raw path is *honest* (and obviously not a browser) |
| 10 | **Headless detection** | `navigator.webdriver`, CDP artefacts, missing APIs, `HeadlessChrome` in the UA | the one tell the rendered path cannot hide without lying | the UA override removes "HeadlessChrome"; `webdriver` remains true in-page |
| 11 | **JavaScript Detections (Cloudflare JSD)** | client-side challenges on *every* request | identifies automated traffic before the page is served | the rendered path runs the same JS a browser does |
| 12 | **Behavioural analysis** | mouse/scroll/timing; HUMAN Bot Defender is explicitly "behaviour-based" | flags non-human interaction patterns | a scraper has no behaviour — it has a request log |
| 13 | **ML classification** | request features across billions of requests (Cloudflare "Adaptive Intelligence" scores most traffic 2–99) | a score below their threshold = challenged | the raw path is a very obvious outlier; the rendered path looks ordinary |
| 14 | **Anomaly detection** | traffic vs a learned per-site baseline | outliers flagged (Cloudflare is deprecating this engine) | 6 rps on one URL is a *very* distinctive shape |
| 15 | **Scraping-specific detections** | ASN **and** fingerprint together | Cloudflare ships "detection IDs for identifying volumetric scraping attacks by ASN and fingerprint" | you cannot spoof both at once without a proxy |
| 16 | **Residential-proxy detection** | proxy traits, IP history, ISP/ASN mismatches | Cloudflare ships "detection IDs for residential proxy traffic" | a proxy trades IP exposure for a new fingerprint tell |
| 17 | **IP reputation / ASN class** | datacenter vs residential vs hosting vs education | blocks whole ASNs | your IP is a residential ISP address — *not* a datacentre one, which is mild luck |
| 18 | **Honeypots** | links/fields only a human would follow | a visited trap = instant ban | selectors that crawl `a[href]` hit them |
| 19 | **Tarpits** | — | accept the connection, serve nothing, log the client | a timeout that looks like a hang |
| 20 | **Login / 2FA / paywall** | the session | the data is not in the response at all | no credentials → no data; the tool's known gap |
| 21 | **Legal & contractual** | who you are | cease-and-desist, DMCA, ToS, contract | hiQ v LinkedIn, 31 F.4th 1180 (9th Cir. 2022): scraping *publicly available* data is not a CFAA violation; Van Buren v. US, 593 U.S. 374 (2021): "exceeds authorized access" means reaching *off-limits* areas, not reading what you were sent |

## 2. What exposes you (IP, and everything else)

| # | Signal | What it reveals | How to blunt it | Measured here |
|---|---|---|---|---|
| 1 | **Your IP + source port** | your household, your ISP, your city | a proxy/VPN (adds its own tells) | `41.193.168.122:13731` — visible in both modes |
| 2 | **X-Forwarded-For / X-Real-IP** | the proxy chain, and it is *spoofable* | don't trust it; it is a fingerprint too | not sent by the tool |
| 3 | **TLS fingerprint (JA3/JA4)** | your client library | use a real browser's stack | raw: Node's; rendered: Chrome's |
| 4 | **HTTP/2 fingerprint** | your HTTP client | same | raw: absent; rendered: Chrome's |
| 5 | **User-Agent + Client-Hints** | your claimed OS/browser, and whether you lie | be consistent, or be a browser | raw: self-identifying; rendered: Chrome/131 + matching hints |
| 6 | **Header order, accept, priority** | your client library's habits | — | raw: minimal; rendered: Chrome's exact set |
| 7 | **Cookies / localStorage** | a stable identity across visits | no jar = no continuity | the tool keeps **no** cookie jar — privacy win, "first visit forever" tell |
| 8 | **Passive fingerprinting** (W3C) | screen, fonts, language, timezone, canvas | a fresh profile per session (the tool does this) | per-render temp profile → weak, changing identity |
| 9 | **Active fingerprinting** (W3C) | canvas/WebGL/audio hashes | none, if you don't run their JS | only in the rendered path (and it *does* run their JS) |
| 10 | **`navigator.webdriver` + CDP traces** | "a browser, but automated" | stealth patches (out of scope here) | true in the rendered path |
| 11 | **GeoIP: ASN → ISP → city/zip** | where you are, roughly | proxy | residential ISP, not a datacentre ASN |
| 12 | **Timing shape** | a machine on a metronome (150 ms exactly, zero jitter) | human-like jitter | the tool's delay is exact and jitterless — a signature |
| 13 | **Request shape** | you fetch only HTML, never the favicon, never an image, never a stylesheet | fetch the assets (pointless) | obvious to any analytics |
| 14 | **Your own UA string** | *your name* | honest UA = reputation; browser UA = anonymity | polite: `scrape-01/1.0` — self-identified, deliberately |

## 3. How a site builds a profile on you

| # | Mechanism | What it accumulates | Consequence |
|---|---|---|---|
| 1 | **First-party cookie / localStorage** | a long-lived id | every request attributed to you |
| 2 | **Browser fingerprint ID** | a hash of your characteristics | survives clearing cookies; a new profile ≠ a new person |
| 3 | **IP + ASN + fingerprint + timing** | a behavioural identity | "the same user" even with no cookies |
| 4 | **Account linkage** | email, session, payment | a logged-in scrape is *named*, not anonymous |
| 5 | **Clustering** | "others who look like you" | a whole IP range, a whole ASN gets labelled |
| 6 | **Partner/ETL sharing** | ad & analytics networks | beyond the site's own logs |
| 7 | **CDN-side logs** | Cloudflare/Akamai see you first | your traffic is correlated before the origin sees it |
| 8 | **Your crawl pattern** | which URLs, in which order, with which parameters | a profile of *your intent* — what you are after |
| 9 | **Legal discovery** | IP + timestamp + UA in a request log | enough to identify a person behind an IP |
| 10 | **Self-identification** | an honest UA names the scraper | reputation, blocking lists, and being easier to serve |

---

## 4. The honest bottom line

* **robots.txt is a promise, not a lock.** Cloudflare says so outright. Monster mode breaks the
  promise; it does not break a lock, and it cannot break the real defences (ML, JSD, behaviour).
* **The defences that actually bite are the behavioural and learned ones** — Cloudflare's ML over
  billions of requests, its JavaScript Detections, and the per-site anomaly baseline. A tool that
  fetches one URL every 150 ms with a zero-jitter clock is a *shape*, and shapes are learnable.
* **Monster mode's rendered path is the strongest thing you can do without lying**: it is Chrome's
  TLS, Chrome's HTTP/2, Chrome's hints, Chrome's JS — so the only remaining tells are the ones
  you cannot remove without deceiving the site (`navigator.webdriver`, the absence of a browsing
  history, the request shape).
* **Your IP is the one thing that never changes** unless you proxy — and proxying replaces it
  with a different, detectable signal (residential-proxy detection is its own detection family).
* **The legal line is in the wrong place to be a technical one.** hiQ (9th Cir. 2022) says
  scraping publicly available data is not a CFAA violation; Van Buren (2021) narrowed "exceeds
  authorized access" to genuinely off-limits areas. But contracts, copyright and the right of
  publicity are separate questions, and no technical counter-measure answers them.

## 5. Practical guidance for this tool

1. **Prefer the page's own data path** — the JSON endpoint behind the page (that is where the
   hourly bars actually are) over scraping rendered HTML.
2. **Render when you must** — the rendered path hides the script; the raw path is a neon sign.
3. **Keep the delay jittered and the pattern irregular** if you care about anomaly detection
   (today it is an exact 150 ms with no jitter).
4. **Do not fetch robots-disallowed paths at scale.** One-off is a judgement call; a loop is not.
5. **Do not pretend to be a person.** The tool's honest UA is a feature: it keeps you out of
   blocklists, and it makes you findable in a way that is *yours to own*.
6. **If you must rotate IPs, understand the trade:** you swap "IP exposure" for "residential
   proxy detection" — and a residential proxy on a scraper is more obvious, not less.

---

## 6. What was implemented (2026-10-20)

Two of the recommendations in §5 are now built:

1. **Jittered pacing** — every request waits `delay + random(60–320 ms)`, with a 700–2,400 ms
   pause every 25 requests. Measured gaps: 705 / 492 / 346 / 345 / 465 ms (was 150 exactly,
   forever). The 100 ms floor and the sequential rule are unchanged.
2. **The browser is a fallback, not the default** — raw HTML is tried first, and Edge is only
   launched when the raw page yields no records. Yahoo's history page: 4.8 s raw vs 17.8 s
   rendered, and the raw body was *larger* than the browser's DOM. A 12,348-row re-crawl went from
   ~17 s per page to 2.2 s in total, with no browser started at all.

The third recommendation is a *policy*, not code: prefer the site's own data path (the JSON
endpoint behind the page) over scraping rendered HTML — which the create flow now does
automatically when the page's DOM does not serve the goal (fault = `source`).

Still deliberately absent: fingerprint spoofing, CAPTCHA solving, proxy rotation to evade bans,
and human impersonation. Those defeat an access decision rather than avoiding a false positive.
