// Local-time date boundaries for sales/profit summaries (SPEC §6.10, §10.5).
// All ranges are computed in the shop's local timezone, then passed to Supabase
// as ISO strings for `created_at >= …` filters.

// Midnight at the start of today.
export function startOfToday() {
  const n = new Date()
  return new Date(n.getFullYear(), n.getMonth(), n.getDate())
}

// Midnight Monday of the current week (Indian shops treat Monday as week start).
export function startOfWeek() {
  const n = new Date()
  const offset = (n.getDay() + 6) % 7 // 0 = Monday … 6 = Sunday
  return new Date(n.getFullYear(), n.getMonth(), n.getDate() - offset)
}

// Midnight on the 1st of the current month.
export function startOfMonth() {
  const n = new Date()
  return new Date(n.getFullYear(), n.getMonth(), 1)
}

// yyyy-mm-dd for <input type="date"> (local, not UTC — toISOString would drift).
export function toInputDate(d) {
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// Parse a yyyy-mm-dd input value into a local midnight Date.
export function fromInputDate(s) {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

// Inclusive end-of-day for a yyyy-mm-dd input value (23:59:59.999 local).
export function endOfInputDate(s) {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d, 23, 59, 59, 999)
}
