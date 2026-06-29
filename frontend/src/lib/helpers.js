// Business logic shared across modules (SPEC §11, §12).
// Formatters live in format.js; this file holds rules that touch money/stock.

// Round to 2 decimals, money-safe (avoids 0.1+0.2 drift before it hits numeric).
export function round2(n) {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100
}

// SPEC §7.5 computed stock status.
//   quantity < threshold → Low | quantity > 1000 → High | else Normal
export function stockStatus(quantity, threshold = 10) {
  const q = Number(quantity || 0)
  if (q <= 0) return { key: 'out', label: 'Out of stock', tone: 'dues' }
  if (q < Number(threshold || 0)) return { key: 'low', label: 'Low', tone: 'saffron' }
  if (q > 1000) return { key: 'high', label: 'High', tone: 'profit' }
  return { key: 'normal', label: 'Normal', tone: 'muted' }
}

// SPEC §12.2 — which tier a buyer pays.
export function rateForBuyer(item, buyerType) {
  return buyerType === 'dealer' ? Number(item.dealer_rate) : Number(item.rate)
}

// SPEC §12.3 — profit on a line.
export function lineProfit(rateCharged, purchaseRate, quantity) {
  return round2((Number(rateCharged) - Number(purchaseRate)) * Number(quantity))
}

// Stock value of an item (SPEC §6.2 — quantity × purchase rate).
export function stockValue(item) {
  return round2(Number(item.quantity || 0) * Number(item.purchase_rate || 0))
}
