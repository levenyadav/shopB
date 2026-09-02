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

// Flat shipping & handling charged on dealer orders; customers pay none. It is
// ONE fee per order, not per line — a cart of five items is still ₹100 — so the
// approval screen only pre-fills it on the first line of a group to be approved.
// Pass-through money: it carries no profit (Golden Rule #6) and no GST.
// A shop that wants this configurable can use charge_rules (migration 023)
// instead; this constant is the single source of truth until then.
export const DEALER_SHIPPING_FEE = 100

export function shippingFeeFor(buyerType) {
  return buyerType === 'dealer' ? DEALER_SHIPPING_FEE : 0
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


// Which GST rate a product is taxed at (migration 034). An item may sit in its
// own slab (5 / 12 / 18 / 28 %); when it doesn't say, the shop's single default
// rate applies. `null`/`''`/undefined on the item means "use the shop default";
// an explicit 0 means the product is exempt, and stays 0.
export function itemGstRate(itemRate, shopRate) {
  const own = itemRate === null || itemRate === undefined || itemRate === ''
    ? null
    : Number(itemRate)
  const rate = own !== null && Number.isFinite(own) ? own : Number(shopRate || 0)
  return rate > 0 ? rate : 0
}

// GST break-up for a bill whose lines sit in DIFFERENT slabs. Each line is
// tax-inclusive (Golden Rule #5 — the locked amount is what the buyer pays), so
// tax is backed out per line and the lines are then grouped by rate: a bill with
// 12% cards and 18% boxes prints one CGST/SGST pair per slab, exactly like Tally.
// `lines` = [{ amount, rate }]. Returns null when nothing is taxed.
//   groups[]  — one per distinct rate, ascending
//   totals    — taxable / cgst / sgst / tax summed across groups
//   rate      — the single rate when every line shares one (else null)
export function gstBreakupByRate(lines) {
  const byRate = new Map()
  for (const ln of lines || []) {
    const rate = Number(ln.rate || 0)
    if (rate <= 0) continue
    byRate.set(rate, round2((byRate.get(rate) || 0) + Number(ln.amount || 0)))
  }
  if (byRate.size === 0) return null

  const groups = [...byRate.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([rate, amount]) => ({ ...gstBreakup(amount, rate), rate }))

  const sum = (k) => round2(groups.reduce((s, g) => s + g[k], 0))
  return {
    groups,
    rate: groups.length === 1 ? groups[0].rate : null,
    taxable: sum('taxable'),
    cgst: sum('cgst'),
    sgst: sum('sgst'),
    tax: sum('tax'),
    total: sum('total'),
  }
}

// A product's GST is stored as ONE combined rate (items.gst_rate, migration
// 034) because that is what a slab is — 18% GST is 9% CGST + 9% SGST, always
// half each intra-state. These two convert between that single stored rate and
// the CGST/SGST pair the owner reads off a supplier's bill and types in.
//
// splitGstRate halves the stored rate for display; combineGstRate adds the two
// halves back into the rate to store. Both are strings-in/strings-out friendly:
// blank in means blank out, which is what "use the shop default" looks like.
export function splitGstRate(rate) {
  if (rate === null || rate === undefined || rate === '') return { cgst: '', sgst: '' }
  const half = round2(Number(rate) / 2)
  return { cgst: String(half), sgst: String(round2(Number(rate) - half)) }
}

export function combineGstRate(cgst, sgst) {
  const c = cgst === '' || cgst === null || cgst === undefined ? null : Number(cgst)
  const s = sgst === '' || sgst === null || sgst === undefined ? null : Number(sgst)
  if (c === null && s === null) return null      // neither given → shop default
  return round2((c || 0) + (s || 0))
}

// ---------------------------------------------------------------------------
// Buying side (migration 036). A supplier bill is goods + postage + the GST the
// supplier charged. Note the direction is the OPPOSITE of a customer invoice:
// a sale amount is tax-INCLUSIVE and tax is backed out of it, while a supplier
// adds tax ON TOP of the goods value. purchase_rate is the pre-tax goods rate,
// so tax here is exclusive and grand total grows.
//
// Neither postage nor tax touches product cost: postage is pass-through and GST
// is recoverable input credit, so profit (Golden Rule #6) is unaffected.
// ---------------------------------------------------------------------------
export function purchaseBillTotals({ goods, postage, cgst, sgst }) {
  const g = round2(goods || 0)
  const p = round2(postage || 0)
  const c = round2(cgst || 0)
  const s = round2(sgst || 0)
  return { goods: g, postage: p, cgst: c, sgst: s, tax: round2(c + s), grand: round2(g + p + c + s) }
}

// Suggested CGST/SGST for a supplier bill, from the GST slab each product sits
// in. Lines in different slabs are taxed at their own rate and summed, then the
// total splits in half (intra-state). Only a SUGGESTION — the owner types what
// the supplier's bill actually says, because a supplier's own rounding rarely
// lands to the rupee. `lines` = [{ amount, rate }].
//
// Postage/freight charged by the supplier on the same bill is part of the
// taxable value (CGST Act §15(2)(c)) — the supplier taxes goods + freight, not
// goods alone. It carries no slab of its own, so it is apportioned across the
// taxed lines by value and taxed at each line's own rate. (It still never lands
// in product cost — see purchaseBillTotals; this is the tax base only.)
export function suggestPurchaseGst(lines, postage = 0) {
  const rows = (lines || []).filter((ln) => Number(ln.rate || 0) > 0)
  const goodsTotal = rows.reduce((s, ln) => s + Number(ln.amount || 0), 0)
  const p = round2(postage || 0)
  let tax = 0
  for (const ln of rows) {
    const amount = Number(ln.amount || 0)
    const freightShare = goodsTotal > 0 ? (amount / goodsTotal) * p : 0
    tax += (amount + freightShare) * (Number(ln.rate) / 100)
  }
  tax = round2(tax)
  if (tax <= 0) return null
  const cgst = round2(tax / 2)
  return { tax, cgst, sgst: round2(tax - cgst) } // sgst takes the remainder
}
