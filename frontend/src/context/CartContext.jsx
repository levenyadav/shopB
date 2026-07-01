import { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react'

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

  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(lines)) } catch { /* quota / private mode */ }
  }, [lines])

  // Add `n` of an item, clamped to its available stock. Merges into the existing
  // line if already in the cart. `item` is a shopfront_items row. An optional
  // `notes` (buyer's note for the shop) is stored on the line; a later add with
  // a fresh note replaces the old one.
  const add = useCallback((item, n = 1, notes = null) => {
    setLines((prev) => {
      const available = Number(item.quantity) || 0
      const moq = Math.max(1, Number(item.moq) || 1)
      const note = notes?.trim() || null
      const i = prev.findIndex((l) => l.id === item.id)
      if (i === -1) {
        const want = Math.min(Math.max(moq, n), available)
        return [...prev, {
          id: item.id,
          name: item.name,
          photo_url: item.photo_url ?? null,
          rate: Number(item.rate),
          dealer_rate: Number(item.dealer_rate),
          moq,
          available,
          qty: want,
          notes: note,
        }]
      }
      const next = [...prev]
      const merged = Math.min(next[i].qty + n, available)
      // refresh stock/price/moq snapshot in case it changed since last add
      next[i] = {
        ...next[i], qty: merged, available, moq,
        rate: Number(item.rate), dealer_rate: Number(item.dealer_rate),
        notes: note ?? next[i].notes,
      }
      return next
    })
  }, [])

  const setQty = useCallback((id, qty) => {
    setLines((prev) => prev.map((l) => {
      if (l.id !== id) return l
      const clamped = Math.max(l.moq, Math.min(l.available, Number(qty) || l.moq))
      return { ...l, qty: clamped }
    }))
  }, [])

  const remove = useCallback((id) => {
    setLines((prev) => prev.filter((l) => l.id !== id))
  }, [])

  const clear = useCallback(() => setLines([]), [])

  const count = useMemo(() => lines.reduce((s, l) => s + l.qty, 0), [lines])
  const distinctCount = lines.length

  const value = { lines, add, setQty, remove, clear, count, distinctCount }
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>
}

export function useCart() {
  const ctx = useContext(CartContext)
  if (!ctx) throw new Error('useCart must be used within CartProvider')
  return ctx
}
