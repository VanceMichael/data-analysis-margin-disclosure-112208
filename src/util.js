export const MISSING = '?'

export const TABLE_NAMES = [
  'accounts',
  'holdings',
  'policy',
  'collateral',
  'quotes',
  'limits',
  'distributions',
  'contract_events',
  'valuation_events',
  'pledge_requests',
]

export function isMissing(v) {
  return v === undefined || v === null || v === MISSING
}

export function num(v) {
  if (isMissing(v)) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

export function dayNumber(day) {
  if (isMissing(day)) return null
  const m = String(day).match(/^D?(\d+)$/)
  return m ? Number(m[1]) : null
}

export function timeKey(day, minute = 0) {
  const d = dayNumber(day)
  return d === null ? null : d * 100000 + Number(minute ?? 0)
}

export function eventTime(e) {
  return timeKey(e.reported_day, e.minute)
}

export function asOfKey(asOf) {
  if (!asOf) return Number.MAX_SAFE_INTEGER
  return timeKey(asOf.day, asOf.minute ?? 9999)
}

export function round(value, digits = 6) {
  if (value === null || value === undefined || Number.isNaN(value)) return null
  const p = 10 ** digits
  return Math.round((value + Number.EPSILON) * p) / p
}

export function money(value) {
  return round(value, 2)
}

export function sum(values) {
  return values.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0)
}

export function groupBy(rows, key) {
  const map = new Map()
  for (const row of rows) {
    const k = typeof key === 'function' ? key(row) : row[key]
    if (!map.has(k)) map.set(k, [])
    map.get(k).push(row)
  }
  return map
}

export function indexBy(rows, key) {
  const map = new Map()
  for (const row of rows) map.set(typeof key === 'function' ? key(row) : row[key], row)
  return map
}

export function clampNonNegative(v) {
  return Math.max(0, v)
}

export function stableId(prefix, parts) {
  return `${prefix}:${parts.filter(Boolean).join('|')}`
}
