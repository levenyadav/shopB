import { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react'
import { snapToMoq } from '../lib/helpers'

// Buyer's shopping cart (SPEC §6.3 — shopfront). A cart is purely client-side
// until checkout: nothing touches the books here. On checkout the Cart page
// inserts one 'pending' orders row per line, all sharing an order_group_id, and
// the existing owner-approval → Sale → stock trigger handles each line exactly
// as a single-item order did (Golden Rules #2, #5 unchanged).
//
// We persist to localStorage so the cart survives a refresh / sign-in redirect.
// Each line stores BOTH rate and dealer_rate (never purchase_rate — Golden Rule
// #4) so the price for the viewer's tier is computed at render/checkout time,
// not frozen at add time when the role may not be known yet.
const CartContext = createContext(null)
const KEY = 'shopb.cart.v1'

function load() {
  try {
    const raw = localStorage.getItem(KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

export function CartProvider({ children }) {
  const [lines, setLines] = useState(load)
  // The last add, for the one "Added · View cart" toast ShopLayout shows. A new
  // object per add so adding the same item twice still re-shows it.
  const [lastAdded, setLastAdded] = useState(null)
  const dismissAdded = useCallback(() => setLastAdded(null), [])

  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(lines)) } catch { /* quota / private mode */ }
  }, [lines])

  // Add `n` of an item, clamped to its available stock. Merges into the existing
  // line if already in the cart. `item` is a shopfront_items row. An optional
  // `notes` (buyer's note for the shop) is stored on the line; a later add with
  // a fresh note replaces the old one.
  const add = useCallback((item, n = 1, notes = null) => {
    setLastAdded({ name: item.name, at: Date.now() })
    setLines((prev) => {
      // Made-to-order items are produced on demand, so the buyer may order any
      // quantity — we don't cap against on-hand stock (which is a placeholder).
      const mto = !!item.made_to_order
      const available = Number(item.quantity) || 0
      const cap = mto ? Infinity : available
      const moq = Math.max(1, Number(item.moq) || 1)
      const note = notes?.trim() || null
      const i = prev.findIndex((l) => l.id === item.id)
      if (i === -1) {
        // Quantity is always a whole multiple of MOQ (MOQ 50 → 50, 100, 150…).
        const want = snapToMoq(n, moq, cap)
        return [...prev, {
          id: item.id,
          name: item.name,
          photo_url: item.photo_url ?? null,
          rate: Number(item.rate),
          dealer_rate: Number(item.dealer_rate),
          moq,
          available,
          made_to_order: mto,
          qty: want,
          notes: note,
        }]
      }
      const next = [...prev]
      // Adding more keeps the total a whole multiple of MOQ.
      const merged = snapToMoq(next[i].qty + n, moq, cap)
      // refresh stock/price/moq snapshot in case it changed since last add
      next[i] = {
        ...next[i], qty: merged, available, moq, made_to_order: mto,
        rate: Number(item.rate), dealer_rate: Number(item.dealer_rate),
        notes: note ?? next[i].notes,
      }
      return next
    })
  }, [])

  const setQty = useCallback((id, qty) => {
    setLines((prev) => prev.map((l) => {
      if (l.id !== id) return l
      // Made-to-order lines have no stock ceiling. Quantity always snaps to a
      // whole multiple of the line's MOQ (MOQ 50 → 50, 100, 150…).
      const cap = l.made_to_order ? Infinity : l.available
      return { ...l, qty: snapToMoq(qty, l.moq, cap) }
    }))
  }, [])

  const remove = useCallback((id) => {
    setLines((prev) => prev.filter((l) => l.id !== id))
  }, [])

  // Re-read every line against today's shopfront (called when the cart opens).
  // A cart can sit on a phone for days; without this the buyer is shown the old
  // price while the order books at the current one, and one item that has since
  // gone out of stock / been hidden fails the whole checkout. `fresh` is the
  // shopfront_items rows for the cart's ids — a line missing from it is no
  // longer sold online and is flagged `unavailable` for the buyer to remove.
  const sync = useCallback((fresh) => {
    const byId = new Map(fresh.map((r) => [r.id, r]))
    setLines((prev) => prev.map((l) => {
      const it = byId.get(l.id)
      if (!it) return { ...l, unavailable: true }
      const mto = !!it.made_to_order
      const available = Number(it.quantity) || 0
      const moq = Math.max(1, Number(it.moq) || 1)
      const cap = mto ? Infinity : available
      return {
        ...l,
        name: it.name, photo_url: it.photo_url ?? null,
        rate: Number(it.rate), dealer_rate: Number(it.dealer_rate),
        moq, available, made_to_order: mto,
        qty: snapToMoq(l.qty, moq, cap),
        // Not enough stock left for even one pack.
        unavailable: !mto && available < moq,
      }
    }))
  }, [])

  const clear = useCallback(() => setLines([]), [])

  const count = useMemo(() => lines.reduce((s, l) => s + l.qty, 0), [lines])
  const distinctCount = lines.length

  const value = { lines, add, setQty, remove, sync, clear, count, distinctCount, lastAdded, dismissAdded }
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>
}

export function useCart() {
  const ctx = useContext(CartContext)
  if (!ctx) throw new Error('useCart must be used within CartProvider')
  return ctx
}
