// Shared formatters. Every figure is shown in mono via the `.fig` class.
export const CURRENCY = '₹'

// The shop's own symbol (Settings → currency). ShopContext sets it once the
// shop loads, so every money() on every screen agrees without each caller
// having to swap the symbol itself.
let symbol = CURRENCY
export function setCurrencySymbol(s) { symbol = s || CURRENCY }

export function money(n) {
  const v = Number(n || 0)
  return symbol + v.toLocaleString('en-IN', { maximumFractionDigits: 2 })
}

export function qty(n) {
  return Number(n || 0).toLocaleString('en-IN')
}

// Human dates for slips, order cards and ledgers (SPEC §3.3 — readable, not raw).
export function dateShort(ts) {
  if (!ts) return '—'
  return new Date(ts).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
  })
}

export function dateTime(ts) {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('en-IN', {
    day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
  })
}
