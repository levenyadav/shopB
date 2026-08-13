// Correcting a purchase bill (migration 039) — the rules, with no React around
// them so they can be tested directly.
//
// These ran only inside an event handler, where a bad assumption is invisible to
// a build and only shows up as a crash in the owner's face. They live here now.
//
// THE THREE LINE SHAPES the editor juggles, which is what every rule below has
// to survive:
//
//   a) existing, from the bill   { mode:'existing', rowId, item:{ id, … } }
//   b) existing, just added      { mode:'existing', rowId:null, item:{ id, … } }
//   c) new product, just added   { mode:'new', name, …, and NO item at all }
//
// (c) has no product yet BY DESIGN — its catalogue row is created on save — so
// "has no item" never means "something is wrong with this line".
// Explicit extension so plain `node --test` can run the tests beside this file;
// Vite resolves it just the same.
import { round2 } from './helpers.js'

// Lines whose product has been deleted from the catalogue (migration 028
// detaches it, keeping the name). Only an `existing` line can be orphaned.
export function orphanLines(lines) {
  return (lines || []).filter((l) => l.mode === 'existing' && !l.item?.id)
}

// Net stock change per product across the WHOLE edit — the same sum migration
// 039 does. Netting (rather than checking line by line) means moving pcs between
// two lines of one product is never wrongly refused.
//
//   originalLines  the bill as it stands in the database
//   lines          the bill as the owner has it on screen
//   onHand         Map of item id → { name, quantity } as stock is right now
//
// Returns [{ id, name, short }] — only products that would go below zero.
export function stockShortfalls({ originalLines, lines, onHand }) {
  const was = new Map()
  for (const l of originalLines || []) {
    const k = l.item?.id
    if (k) was.set(k, (was.get(k) || 0) + Number(l.quantity || 0))
  }
  const now = new Map()
  for (const l of lines || []) {
    const k = l.item?.id
    if (k) now.set(k, (now.get(k) || 0) + Number(l.quantity || 0))
  }

  const out = []
  for (const [itemId, before] of was) {
    const delta = round2((now.get(itemId) || 0) - before)
    const stock = Number(onHand?.get(itemId)?.quantity ?? 0)
    if (delta < 0 && round2(stock + delta) < 0) {
      out.push({
        id: itemId,
        name: onHand?.get(itemId)?.name || 'this item',
        short: round2(-(stock + delta)),
      })
    }
  }
  return out
}

// Cost rates the correction will push onto the catalogue: a corrected cost
// becomes the product's cost, so profit on future sales uses it (SPEC §6.1).
// A `new` line sets its own cost as it is created, so it is not a change.
export function costRateChanges(lines) {
  const seen = new Map()
  for (const l of lines || []) {
    if (l.mode !== 'existing' || !l.item?.id || l.purchase_rate === '' || l.purchase_rate == null) continue
    const to = round2(l.purchase_rate)
    const from = l.item.purchase_rate
    if (from != null && round2(from) !== to) {
      seen.set(l.item.id, { id: l.item.id, name: l.item.name, from: round2(from), to })
    }
  }
  return [...seen.values()]
}

// Everything that stops a correction being saved, as one message the owner can
// act on, or '' when it is good to go. `fmtQty` formats pieces for the message.
export function billEditProblem({ lines, shortfalls, fmtQty = String }) {
  if (!lines?.length) {
    return 'A bill must have at least one product. Add one, or press Cancel to leave the bill as it was.'
  }
  const orphans = orphanLines(lines)
  if (orphans.length) {
    return `"${orphans[0].item?.name || 'A product on this bill'}" was deleted from your catalogue, `
         + `so this bill can't be corrected. Remove that line first, or add the product back to Inventory.`
  }
  if (shortfalls?.length) {
    return `Not enough stock for this change: ${shortfalls
      .map((s) => `${s.name} (short by ${fmtQty(s.short)} pcs)`)
      .join(', ')}. Those pcs have already been sold, so the bill can't be cut that far.`
  }
  return ''
}
