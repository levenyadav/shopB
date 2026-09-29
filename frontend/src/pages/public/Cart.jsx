import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  IconPhoto, IconTrash, IconShoppingCart, IconLogin2, } from '@tabler/icons-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import { useShop } from '../../context/ShopContext'
import { useCart } from '../../context/CartContext'
import { money } from '../../lib/format'
import { rateForBuyer, round2 } from '../../lib/helpers'
import { Button, Spinner, Img } from '../../components/ui'
import QtyStepper from '../../components/QtyStepper'
import { BackLink } from '../../components/BackButton'

// SPEC §6.3 — the cart. A cart is client-side only (CartContext); nothing touches
// the books here. On checkout we insert one 'pending' orders row per line, all
// sharing one order_group_id, and the existing owner-approval → Sale → stock
// trigger handles each line exactly like a single-item order (Golden Rules #2,
// #5). The price for each line is locked at checkout for the viewer's tier
// (dealer → dealer_rate, else rate); purchase_rate is never involved.
export default function Cart() {
  const navigate = useNavigate()
  const { role, profile } = useAuth()
  const { shopId, currency } = useShop()
  const { lines, setQty, remove, sync, clear } = useCart()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  // Refresh prices and stock from the live shopfront once when the cart opens,
  // so the total shown is the total the order will book (the server re-prices
  // every line at checkout anyway — normalize_shopfront_order).
  const idsKey = lines.map((l) => l.id).sort().join(',')
  useEffect(() => {
    if (!idsKey) return
    let active = true
    supabase
      .from('shopfront_items')
      .select('id, name, photo_url, quantity, rate, dealer_rate, moq, made_to_order')
      .in('id', idsKey.split(','))
      .then(({ data, error }) => { if (active && !error) sync(data ?? []) })
    return () => { active = false }
  }, [idsKey, sync])

  const unavailable = lines.filter((l) => l.unavailable)
  const orderable = lines.filter((l) => !l.unavailable)

  const isBuyer = role === 'customer' || role === 'dealer'
  const priceOf = (l) => rateForBuyer(l, role)
  const total = round2(orderable.reduce((s, l) => s + priceOf(l) * l.qty, 0))

  async function checkout() {
    if (!isBuyer) { navigate('/login'); return }
    if (orderable.length === 0) return
    if (unavailable.length) {
      setErr(`Remove ${unavailable.map((l) => l.name).join(', ')} first — ${unavailable.length === 1 ? 'it is' : 'they are'} no longer available.`)
      return
    }
    setBusy(true); setErr('')
    const groupId = crypto.randomUUID()
    const rows = orderable.map((l) => {
      const rate = round2(priceOf(l))
      return {
        shop_id: shopId,
        item_id: l.id,
        buyer_id: profile.id,
        buyer_type: role,
        quantity: l.qty,
        rate_at_order: rate,
        amount: round2(rate * l.qty),
        notes: l.notes?.trim() || null,
        order_group_id: groupId,
      }
    })
    const { error } = await supabase.from('orders').insert(rows)
    setBusy(false)
    if (error) { setErr(error.message); return }
    clear()
    navigate('/orders')
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <BackLink />

      <div>
        <h1 className="font-[var(--font-display)] text-3xl font-bold">Your cart</h1>
        <p className="text-muted">Review your items, then place the order. We confirm before packing.</p>
      </div>

      {lines.length === 0 ? (
        <div className="grid place-items-center gap-3 rounded-lg border border-dashed border-line py-16 text-center text-muted">
          <IconShoppingCart size={40} stroke={1.3} />
          <p>Your cart is empty.</p>
          <Link to="/" className="font-semibold text-peacock hover:underline">Browse the shop →</Link>
        </div>
      ) : (
        <>
          <ul className="space-y-3">
            {lines.map((l) => (
              <li key={l.id} className="flex items-center gap-4 rounded-lg border border-line bg-card p-3">
                <Link to={`/item/${l.id}`} className="shrink-0">
                  <Thumb url={l.photo_url} />
                </Link>
                <div className="min-w-0 flex-1">
                  <Link to={`/item/${l.id}`} className="truncate font-medium text-ink hover:text-peacock">{l.name}</Link>
                  {l.unavailable && (
                    <p className="text-xs font-medium text-dues">No longer available — remove it to place your order.</p>
                  )}
                  <p className="text-xs text-muted">
                    <span className="fig">{money(priceOf(l)).replace('₹', currency)}</span> each
                    {l.moq > 1 && <> · in packs of <span className="fig">{l.moq}</span></>}
                  </p>
                  <div className="mt-2 flex items-start gap-3">
                    <QtyStepper
                      value={l.qty} moq={l.moq} size="sm"
                      cap={l.made_to_order ? Infinity : l.available}
                      onChange={(q) => setQty(l.id, q)}
                    />
                    {l.made_to_order
                      ? <span className="mt-2 text-xs text-muted">Make to order</span>
                      : <span className="mt-2 text-xs text-muted"><span className="fig">{l.available}</span> in stock</span>}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-2">
                  <p className="fig font-semibold">{money(priceOf(l) * l.qty).replace('₹', currency)}</p>
                  <button type="button" onClick={() => remove(l.id)}
                          className="inline-flex items-center gap-1 text-xs text-muted hover:text-dues" aria-label="Remove">
                    <IconTrash size={15} /> Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>

          <div className="space-y-4 rounded-lg border border-line bg-card p-5">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <span className="text-muted">Total</span>
              <span className="fig text-2xl font-bold">{money(total).replace('₹', currency)}</span>
            </div>

            {err && <p className="rounded-lg bg-dues/10 px-3 py-2 text-sm text-dues">{err}</p>}

            {isBuyer ? (
              <>
                <Button onClick={checkout} disabled={busy || unavailable.length > 0} className="w-full">
                  {busy ? <><Spinner /> Placing order…</> : 'Place order'}
                </Button>
                <p className="text-center text-xs text-muted">
                  Stock is held only after the shop confirms your order.
                </p>
              </>
            ) : role === 'owner' || role === 'staff' ? (
              <p className="rounded-lg border border-line bg-paper-2 px-4 py-3 text-sm text-muted">
                You’re signed in as {role}. Ordering is for customers and dealers.
              </p>
            ) : (
              <Link
                to="/login"
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-peacock px-5 py-3 font-semibold text-white hover:bg-peacock-700"
              >
                <IconLogin2 size={19} /> Sign in or register to place your order
              </Link>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function Thumb({ url }) {
  return (
    <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-line bg-paper-2">
      {url ? <Img src={url} thumb alt="" className="h-full w-full object-cover" />
           : <div className="grid h-full w-full place-items-center text-muted"><IconPhoto size={22} /></div>}
    </div>
  )
}
