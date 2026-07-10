// Business logic shared across modules (SPEC §11, §12).
// Formatters live in format.js; this file holds rules that touch money/stock.

// Round to 2 decimals, money-safe (avoids 0.1+0.2 drift before it hits numeric).
export function round2(n) {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100
}

// True when a Supabase/Postgres error is the "Company No. already used" unique
// violation (index items_shop_company_no_uidx, migration 031). Matches on the
// message/constraint name as well as SQLSTATE 23505, because a rethrown or
// wrapped error can lose its `.code` while the raw text ("duplicate key value
// violates unique constraint ...company_no...") always survives — so the owner
// never sees the raw Postgres string.
export function isDuplicateCompanyNo(err) {
  if (!err) return false
  const msg = String(err.message || err.details || err)
  const looksDuplicate = err.code === '23505' || /duplicate key value/i.test(msg)
  return looksDuplicate && /company_no|items_shop_company_no/i.test(msg)
}

// Snap a requested quantity to a valid orderable amount: a WHOLE multiple of the
// item's MOQ (minimum-order quantity), at least one MOQ, and never above the
// stock cap. MOQ 50 → allowed 50, 100, 150… A stock ceiling that isn't itself a
// multiple is floored to the largest whole multiple that still fits (available
// 120, MOQ 50 → max 100), so a buyer can never order a partial pack the shop
// can't fulfil. Pass cap = Infinity for made-to-order (no stock ceiling).
export function snapToMoq(qty, moq, cap = Infinity) {
  const step = Math.max(1, Math.floor(Number(moq) || 1))
  const wanted = Math.max(step, Math.round((Number(qty) || step) / step) * step)
  if (!Number.isFinite(cap)) return wanted
  const maxMultiple = Math.floor(Number(cap) / step) * step
  // cap < one MOQ → item isn't orderable; callers guard that (belowMoq). Return
  // one step so the displayed number stays a valid multiple.
  if (maxMultiple < step) return step
  return Math.min(wanted, maxMultiple)
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

// Normalise a typed Indian mobile number to E.164 (+91XXXXXXXXXX) for Supabase
// phone auth and wa.me links. Accepts "98765 43210", "098765-43210",
// "+91 98765 43210", "919876543210". Returns null if it isn't a plausible
// 10-digit mobile (so callers can reject before sending an OTP).
export function toE164India(input) {
  const digits = String(input || '').replace(/\D/g, '')
  let local = digits
  if (local.startsWith('91') && local.length === 12) local = local.slice(2)
  else if (local.length === 11 && local.startsWith('0')) local = local.slice(1)
  // Indian mobiles are 10 digits starting 6–9.
  if (!/^[6-9]\d{9}$/.test(local)) return null
  return '+91' + local
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

// GST breakup for a customer invoice (SPEC §15). The sale amount is locked
// (Golden Rule #5) and is what the buyer owes, so we treat it as tax-INCLUSIVE
// and back out the tax — the grand total stays equal to the sale amount. CGST
// and SGST split the tax in half (intra-state). Returns null when no GST applies.
export function gstBreakup(amountInclusive, ratePct) {
  const rate = Number(ratePct || 0)
  const amount = round2(amountInclusive)
  if (rate <= 0) return null
  const taxable = round2(amount / (1 + rate / 100))
  const tax = round2(amount - taxable)
  const cgst = round2(tax / 2)
  const sgst = round2(tax - cgst) // remainder, so cgst + sgst === tax exactly
  return { rate, taxable, cgst, sgst, tax, total: amount }
}
