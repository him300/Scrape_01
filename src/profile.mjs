// Crawl profiles: "polite" (default) vs "monster" (aggressive).
//
// A profile is the crawl BUDGET and the crawl MANNERS:
//   polite  - obey robots.txt, wait 1s between requests, 3 retries, plain HTTP
//   monster - ignore robots.txt, wait 150ms, 6 retries, render JavaScript first
//
// The monster profile is deliberately bounded. It removes politeness, it does
// not remove restraint: requests stay sequential per host and the delay never
// drops below MIN_DELAY_FLOOR_MS, so "monster" cannot be turned into a flood.

export const MIN_DELAY_FLOOR_MS = 100;   // hard floor: one request per 100ms per host
export const MAX_CONCURRENCY = 1;        // sequential by design — no parallel writers

const POLITE_UA = 'scrape-01/1.0 (+local dataset builder; polite)';
const MONSTER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const PROFILES = {
  polite: {
    mode: 'polite',
    robots: true,
    render: false,
    userAgent: POLITE_UA,
    minDelayMs: 1000,
    retries: 3,
    timeoutMs: 30000,
    settleMs: 0,
    jitter: null,
    thinkPause: null,
    limits: { maxPages: 200, maxRows: 200000, maxDepth: 1 },
  },
  monster: {
    mode: 'monster',
    robots: false,
    render: true,
    userAgent: MONSTER_UA,
    minDelayMs: 150,
    retries: 6,
    timeoutMs: 60000,
    settleMs: 1200,
    // A fixed delay is a signature: exact 150 ms, zero jitter, one URL, forever
    // is the shape of a machine. These make the cadence ordinary.
    jitter: { min: 60, max: 320 },
    thinkPause: { every: 25, min: 700, max: 2400 },
    limits: { maxPages: 5000, maxRows: 2000000, maxDepth: 6 },
  },
};

export const PROFILE_NAMES = Object.keys(PROFILES);

// Keys a dataset config may override on top of a named profile.
const OVERRIDABLE = new Set(['robots', 'render', 'userAgent', 'minDelayMs', 'retries', 'timeoutMs', 'settleMs']);

export function getProfile(name) {
  const key = String(name || 'polite').toLowerCase();
  if (!PROFILES[key]) throw new Error(`unknown profile "${name}" (have: ${PROFILE_NAMES.join('|')})`);
  return { ...PROFILES[key], limits: { ...PROFILES[key].limits } };
}

// Resolve the effective profile for a run:
//   1. a named profile or an override object on the dataset config
//   2. a runtime flag (--monster / monster: true)
//   3. the polite default
export function resolveProfile({ datasetProfile = null, monster = false, profileName = null, respectRobots = false, overrides = {} } = {}) {
  let base;
  if (datasetProfile) {
    if (typeof datasetProfile === 'string') base = getProfile(datasetProfile);
    else {
      const named = getProfile(datasetProfile.mode || datasetProfile.profile || 'polite');
      base = { ...named, limits: { ...named.limits } };
      for (const [k, v] of Object.entries(datasetProfile)) {
        if (k === 'limits' && v && typeof v === 'object') base.limits = { ...base.limits, ...v };
        else if (OVERRIDABLE.has(k)) base[k] = v;
      }
    }
  } else if (profileName) base = getProfile(profileName);
  else if (monster) base = getProfile('monster');
  else base = getProfile('polite');

  for (const [k, v] of Object.entries(overrides || {})) {
    if (v === undefined || v === null) continue;
    if (k === 'limits' && v && typeof v === 'object') base.limits = { ...base.limits, ...v };
    else if (OVERRIDABLE.has(k)) base[k] = v;
  }

  // guardrails: the floor and sequential access are not negotiable
  base.minDelayMs = Math.max(MIN_DELAY_FLOOR_MS, Number(base.minDelayMs) || 0);
  base.retries = Math.max(0, Math.min(10, Number(base.retries) || 0));
  base.timeoutMs = Math.max(5000, Number(base.timeoutMs) || 30000);
  base.settleMs = Math.max(0, Number(base.settleMs) || 0);
  base.concurrency = MAX_CONCURRENCY;
  // "Respect robots" is the one thing you may switch back ON inside monster
  // mode: keep the rendering and the speed, but obey the site's crawl policy.
  if (respectRobots) base.robots = true;
  return base;
}

export function describeProfile(p) {
  return [
    `mode=${p.mode}`,
    `robots=${p.robots ? 'obeyed' : 'ignored'}`,
    `render=${p.render ? 'js' : 'off'}`,
    `delay=${p.minDelayMs}ms`,
    `retries=${p.retries}`,
    `timeout=${p.timeoutMs}ms`,
    `maxPages=${p.limits.maxPages}`,
  ].join(' ');
}
