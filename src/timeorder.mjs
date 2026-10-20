// Time-series detection and ordering rules.
//
// A time series is a property of the VALUES, not of the declared type: a string
// column of "Oct 20, 2026" is a time series, and so is a number column of epoch
// seconds. This module detects that, records HOW it was interpreted, and
// refuses to guess when the interpretation is ambiguous.

export const TIME_KINDS = ['iso', 'epochMillis', 'epochSeconds', 'epochMicros', 'yearMonth', 'year', 'dayFirst', 'monthFirst', 'parsed'];

// The PRECISION a value carries. A page that says "July 1, 2025" offers a DAY.
// Turning that into "2025-07-01T00:00:00.000Z" invents a time of day (and, in
// a non-UTC zone, shifts the day) — so the precision has to be measured and
// kept, never upgraded.
export const PRECISIONS = ['second', 'day', 'month', 'year'];

export function datePrecision(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (/^\d{9,13}(\.\d+)?$/.test(s)) return 'second';                    // epoch
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}/.test(s)) return 'second';    // ISO with a clock
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return 'day';
  if (/^\d{4}-\d{2}$/.test(s)) return 'month';
  if (/^\d{4}$/.test(s)) return 'year';
  if (/\d{1,2}:\d{2}/.test(s)) return 'second';                         // a clock time is present
  if (/\b(19|20)\d{2}\b/.test(s)) return 'day';
  return null;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/;
const YM_RE = /^\d{4}-\d{2}$/;
const Y_RE = /^\d{4}$/;
const SLASH_RE = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/;
const SAMPLE = 200;
const COVERAGE = 0.95;

const isInt = (v) => /^-?\d+$/.test(String(v).trim());

// how a value under a given kind maps to a comparable instant (ms since epoch)
export function timeKey(value, kind) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const s = String(value).trim();
  switch (kind) {
    case 'iso': {
      if (!ISO_RE.test(s)) return null;
      const t = Date.parse(s);
      return Number.isFinite(t) ? t : null;
    }
    case 'epochSeconds': {
      if (!isInt(s)) return null;
      const n = Number(s);
      return n >= 1e9 && n < 1e11 ? n * 1000 : null;
    }
    case 'epochMillis': {
      if (!isInt(s)) return null;
      const n = Number(s);
      return n >= 1e12 && n < 1e14 ? n : null;
    }
    case 'epochMicros': {
      if (!isInt(s)) return null;
      const n = Number(s);
      return n >= 1e15 && n < 1e18 ? Math.round(n / 1000) : null;
    }
    case 'yearMonth': {
      if (!YM_RE.test(s)) return null;
      const t = Date.parse(`${s}-01T00:00:00Z`);
      return Number.isFinite(t) ? t : null;
    }
    case 'year': {
      // a year written in a CSV is a STRING; a NUMBER that looks like a year is
      // far more likely a price, so it is not accepted here
      if (typeof value !== 'string' || !Y_RE.test(s)) return null;
      const y = Number(s);
      if (y < 1900 || y > 2100) return null;
      const t = Date.parse(`${s}-01-01T00:00:00Z`);
      return Number.isFinite(t) ? t : null;
    }
    case 'dayFirst': {
      const m = SLASH_RE.exec(s);
      if (!m) return null;
      const d = Number(m[1]); const mo = Number(m[2]); const y = Number(m[3]);
      const year = y < 100 ? 2000 + y : y;
      if (d < 1 || d > 31 || mo < 1 || mo > 12) return null;
      return Date.UTC(year, mo - 1, d);
    }
    case 'monthFirst': {
      const m = SLASH_RE.exec(s);
      if (!m) return null;
      const mo = Number(m[1]); const d = Number(m[2]); const y = Number(m[3]);
      const year = y < 100 ? 2000 + y : y;
      if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
      return Date.UTC(year, mo - 1, d);
    }
    case 'parsed': {
      if (SLASH_RE.test(s)) return null;         // ambiguous by construction
      // Date.parse is dangerously lenient: "3.10" is a time today and "0" is
      // a date in 2000. A time axis must LOOK like a date: a 4-digit year and
      // something that is not a bare number.
      if (/^[\d.,\s:+-]+$/.test(s)) return null;
      if (!/\b(19|20)\d{2}\b/.test(s)) return null;
      const t = Date.parse(s);
      return Number.isFinite(t) ? t : null;
    }
    default:
      return null;
  }
}

// Which interpretation covers this sample best? Strict: a kind must explain
// at least 95% of the values, and the slash forms need the sample to break the
// day/month tie.
export function detectTimeKind(values) {
  const sample = values.filter((v) => v !== null && v !== undefined && String(v).trim() !== '').slice(0, SAMPLE);
  if (!sample.length) return { kind: null, coverage: 0, reason: 'no values' };

  const coverage = (kind) => sample.filter((v) => timeKey(v, kind) !== null).length / sample.length;
  // the finest precision the sample actually carries (never finer than the source)
  const precision = (kind) => {
    if (['epochMillis', 'epochSeconds', 'epochMicros'].includes(kind)) return 'second';
    if (kind === 'yearMonth') return 'month';
    if (kind === 'year') return 'year';
    const ps = sample.map((v) => datePrecision(v)).filter(Boolean);
    if (!ps.length) return null;
    if (ps.includes('second')) return 'second';
    if (ps.includes('day')) return 'day';
    if (ps.includes('month')) return 'month';
    return 'year';
  };

  // slash dates: day-first and month-first both need the tie broken
  const slash = sample.filter((v) => SLASH_RE.test(String(v).trim()));
  let firstBig = 0; let secondBig = 0;
  for (const v of slash) {
    const m = SLASH_RE.exec(String(v).trim());
    if (Number(m[1]) > 12) firstBig++;
    if (Number(m[2]) > 12) secondBig++;
  }
  const slashAmbiguous = slash.length > 0 && firstBig === 0 && secondBig === 0;

  const ladder = ['iso', 'epochMillis', 'epochSeconds', 'epochMicros', 'yearMonth', 'year'];
  for (const kind of ladder) {
    const cov = coverage(kind);
    if (cov >= COVERAGE) return { kind, coverage: cov, precision: precision(kind), reason: `${Math.round(cov * 100)}% of the sample parses as ${kind}` };
  }
  if (slash.length) {
    if (firstBig > 0) { const cov = coverage('dayFirst'); if (cov >= COVERAGE) return { kind: 'dayFirst', coverage: cov, precision: precision('dayFirst'), reason: `${Math.round(cov * 100)}% parse as day-first (a value with a day > 12 breaks the tie)` }; }
    if (secondBig > 0) { const cov = coverage('monthFirst'); if (cov >= COVERAGE) return { kind: 'monthFirst', coverage: cov, precision: precision('monthFirst'), reason: `${Math.round(cov * 100)}% parse as month-first (a value with a day > 12 breaks the tie)` }; }
    if (slashAmbiguous) return { kind: null, coverage: 0, reason: 'the dates are ambiguous (day-first vs month-first) and no value breaks the tie' };
  }
  const cov = coverage('parsed');
  if (cov >= COVERAGE) return { kind: 'parsed', coverage: cov, precision: precision('parsed'), reason: `${Math.round(cov * 100)}% parse as a date/time` };
  return { kind: null, coverage: cov, reason: `only ${Math.round(cov * 100)}% of the sample parses as a date/time` };
}

// Which column of this dataset is the time axis? Strict rules:
//  - the declared key wins, if it is time-like
//  - otherwise the time-like column with the most distinct values
//  - a column whose values never change is not a time series
export function detectTimeColumn(columns, records, { key = [] } = {}) {
  const candidates = [];
  const rejected = [];
  for (const col of columns) {
    const values = records.map((r) => r?.[col]);
    const nonEmpty = values.filter((v) => v !== null && v !== undefined && String(v).trim() !== '');
    if (!nonEmpty.length) { rejected.push({ column: col, reason: 'no values' }); continue; }
    const distinct = new Set(nonEmpty.map(String)).size;
    if (distinct < 2) { rejected.push({ column: col, reason: 'the value never changes — not a time series' }); continue; }
    const det = detectTimeKind(values);
    if (!det.kind) { rejected.push({ column: col, reason: det.reason }); continue; }
    candidates.push({ column: col, kind: det.kind, precision: det.precision || null, coverage: det.coverage, distinct, reason: det.reason, isKey: key.includes(col) });
  }
  if (!candidates.length) return { column: null, kind: null, candidates: [], rejected, reason: 'no column holds date-like values' };

  const keyFirst = candidates.find((c) => c.isKey);
  const ranked = [...candidates].sort((a, b) => (b.isKey ? 1 : 0) - (a.isKey ? 1 : 0) || b.distinct - a.distinct);
  const best = keyFirst || ranked[0];
  const ties = ranked.filter((c) => c.distinct === best.distinct && c.column !== best.column).map((c) => c.column);
  return {
    column: best.column,
    kind: best.kind,
    precision: best.precision || null,
    coverage: best.coverage,
    distinct: best.distinct,
    reason: best.reason,
    candidates: ranked.map((c) => ({ column: c.column, kind: c.kind, distinct: c.distinct, coverage: c.coverage })),
    rejected,
    ties,
  };
}

// Sort helper: compare two values under a recorded kind. Unparsable values
// sort last (they are not silently given a date).
export function compareTime(a, b, kind) {
  const ka = timeKey(a, kind);
  const kb = timeKey(b, kind);
  if (ka === null && kb === null) return 0;
  if (ka === null) return 1;
  if (kb === null) return -1;
  return ka - kb;
}
