// Shared formatters. Every figure is shown in mono via the `.fig` class.
export const CURRENCY = '₹'

export function money(n) {
  const v = Number(n || 0)
  return CURRENCY + v.toLocaleString('en-IN', { maximumFractionDigits: 2 })
}

export function qty(n) {
  return Number(n || 0).toLocaleString('en-IN')
}
