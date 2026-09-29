import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { IconTrash, IconShoppingBag } from '@tabler/icons-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import { useShop } from '../../context/ShopContext'
import { useCart } from '../../context/CartContext'
import { money } from '../../lib/format'
import { rateForBuyer, round2, shippingFeeFor } from '../../lib/helpers'
import { Spinner, Img, PhotoPlaceholder } from '../../components/ui'
import QtyStepper from '../../components/QtyStepper'

// SPEC §6.3 — the cart. A cart is client-side only (CartContext); nothing touches
// the books here. On checkout we insert one 'pending' orders row per line, all
// sharing one order_group_id, and the existing owner-approval → Sale → stock
// trigger handles each line exactly like a single-item order (Golden Rules #2,
// #5). The price for each line is locked at checkout for the viewer's tier
// (dealer → dealer_rate, else rate); purchase_rate is never involved.
export default function Cart() {
  const navigate = useNavigate()
  const { role, profile } = useAuth()
  const { shopId } = useShop()
  const { lines, setQty, remove, sync, clear } = useCart()
  const [note, setNote] = useState('')
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

  const c = (n) => money(n)
  const unavailable = lines.filter((l) => l.unavailable)
  const orderable = lines.filter((l) => !l.unavailable)

  const isBuyer = role === 'customer' || role === 'dealer'
  const isStaffSide = role === 'owner' || role === 'staff'
  const priceOf = (l) => rateForBuyer(l, role)
  const itemsTotal = round2(orderable.reduce((s, l) => s + priceOf(l) * l.qty, 0))
  // Dealers pay one flat shipping & handling fee per order, billed when the shop
  // confirms. Shown here so the total never grows after the order is placed —
  // the order page adds the same figure (MyOrderDetail).
  const shipping = orderable.length ? shippingFeeFor(role) : 0
  const total = round2(itemsTotal + shipping)

  async function checkout() {
    if (!isBuyer) { navigate('/login?next=/cart'); return }
    if (orderable.length === 0) return
    if (unavailable.length) {
      setErr(`Remove ${unavailable.map((l) => l.name).join(', ')} first — ${unavailable.length === 1 ? 'it is' : 'they are'} no longer available.`)
      return
    }
    setBusy(true); setErr('')
    const groupId = crypto.randomUUID()
    const orderNote = note.trim()
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
        // The order-wide note rides on every line, so the shop sees it whichever
        // line of the order it opens.
        notes: [l.notes?.trim(), orderNote].filter(Boolean).join(' — ') || null,
        order_group_id: groupId,
      }
    })
    const { data, error } = await supabase.from('orders').insert(rows).select('id')
    setBusy(false)
    if (error) { setErr(`Couldn’t place the order: ${error.message}. Please try again.`); return }
    clear()
    navigate(data?.[0]?.id ? `/orders/${data[0].id}?placed=1` : '/orders', { replace: true })
  }

  if (lines.length === 0) {
    return (
      <div className="mx-auto flex max-w-sm flex-col items-center py-16 text-center">
        <IconShoppingBag size={40} stroke={1.3} className="text-muted" aria-hidden />
        <h1 className="mt-3 font-[var(--font-display)] text-xl font-bold text-ink">Your cart is empty</h1>
        <p className="mt-1 text-sm text-muted">Add products from the shop and they’ll appear here.</p>
        <Link to="/" className="mt-5 inline-flex h-11 items-center rounded-lg bg-peacock px-6 text-sm font-semibold text-white transition-colors duration-150 hover:bg-peacock-700">
          Browse the shop
        </Link>
      </div>
    )
  }

  const action = isStaffSide ? null : isBuyer ? (
    <button
      type="button"
      onClick={checkout}
      disabled={busy || unavailable.length > 0}
      className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-peacock px-5 text-[15px] font-semibold text-white transition-colors duration-150 hover:bg-peacock-700 disabled:opacity-50"
    >
      {busy ? <><Spinner /> Placing order…</> : <>Place order · <span className="fig">{c(total)}</span></>}
    </button>
  ) : (
    <Link
      to="/login?next=/cart"
      className="inline-flex h-12 w-full items-center justify-center rounded-lg bg-peacock px-5 text-[15px] font-semibold text-white transition-colors duration-150 hover:bg-peacock-700"
    >
      Sign in to place order
    </Link>
  )

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="font-[var(--font-display)] text-2xl font-bold text-ink sm:text-3xl">
        Cart <span className="fig text-lg font-medium text-muted">({lines.length})</span>
      </h1>

      <div className="mt-4 lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start lg:gap-10">
        <div>
          <ul className="divide-y divide-line border-y border-line">
            {lines.map((l) => (
              <li key={l.id} className="flex gap-3 py-4 sm:gap-4">
                <Link to={`/item/${l.id}`} className="shrink-0" tabIndex={-1} aria-hidden>
                  <Thumb url={l.photo_url} />
                </Link>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-3">
                    <Link to={`/item/${l.id}`} className="line-clamp-2 text-[15px] leading-snug text-ink hover:underline">{l.name}</Link>
                    <p className="fig shrink-0 font-semibold text-ink">{c(priceOf(l) * l.qty)}</p>
                  </div>
                  <p className="mt-0.5 text-sm text-muted">
                    <span className="fig">{c(priceOf(l))}</span> each
                    {l.moq > 1 && <> · packs of <span className="fig">{l.moq}</span></>}
                  </p>
                  {l.unavailable ? (
                    <p className="mt-1 text-sm font-medium text-dues">No longer available — remove it to place your order.</p>
                  ) : !l.made_to_order && l.qty >= Math.floor(l.available / l.moq) * l.moq && (
                    <p className="mt-1 text-xs text-saffron">That’s all we have — <span className="fig">{l.available}</span> in stock.</p>
                  )}
                  <div className="mt-2 flex items-start justify-between gap-3">
                    {l.unavailable ? <span /> : (
                      <QtyStepper
                        value={l.qty} moq={l.moq} size="sm"
                        cap={l.made_to_order ? Infinity : l.available}
                        onChange={(q) => setQty(l.id, q)}
                      />
                    )}
                    <button
                      type="button" onClick={() => remove(l.id)}
                      aria-label={`Remove ${l.name}`}
                      className="-mr-2 grid h-11 w-11 place-items-center rounded-lg text-muted transition-colors duration-150 hover:bg-paper-2 hover:text-dues"
                    >
                      <IconTrash size={19} aria-hidden />
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>

          {!isStaffSide && (
            <details className="group mt-4" open={!!note}>
              <summary className="inline-flex min-h-11 cursor-pointer list-none items-center text-sm font-medium text-peacock hover:underline [&::-webkit-details-marker]:hidden">
                <span className="group-open:hidden">+ Add a note for the shop</span>
                <span className="hidden group-open:inline">Note for the shop</span>
              </summary>
              <label htmlFor="order-note" className="sr-only">Note for the shop</label>
              <textarea
                id="order-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. need by Friday, gift wrap, call before delivery…"
                className="mt-1 w-full rounded-lg border border-line bg-card px-3 py-2.5 text-[15px] text-ink outline-none transition-colors duration-150 focus:border-peacock focus:ring-1 focus:ring-peacock"
              />
            </details>
          )}
        </div>

        <aside className="mt-6 rounded-xl bg-card p-5 ring-1 ring-line lg:sticky lg:top-24 lg:mt-0" aria-label="Order summary">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-muted">Items</dt>
              <dd className="fig text-ink">{c(itemsTotal)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted">Shipping & handling</dt>
              <dd className="fig text-ink">{shipping > 0 ? c(shipping) : 'Free'}</dd>
            </div>
            <div className="flex justify-between gap-3 border-t border-line pt-3 text-base">
              <dt className="font-semibold text-ink">Total</dt>
              <dd className="fig font-semibold text-ink">{c(total)}</dd>
            </div>
          </dl>
          <p className="mt-3 text-xs leading-relaxed text-muted">
            Nothing is charged now. The shop confirms your order before packing it; prices include GST.
          </p>

          {err && <p role="alert" className="mt-3 rounded-lg bg-dues/10 px-3 py-2 text-sm text-dues">{err}</p>}

          {isStaffSide ? (
            <p className="mt-4 rounded-lg bg-paper-2 px-4 py-3 text-sm text-muted">
              You’re signed in as {role}. Ordering is for customers and dealers.
            </p>
          ) : (
            <>
              {/* Pinned to the bottom on phones — the one action on this screen. */}
              <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-card px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] lg:static lg:mt-4 lg:border-0 lg:p-0">
                {action}
              </div>
            </>
          )}
        </aside>
      </div>
      {/* Room for the pinned Place-order bar on phones. */}
      {!isStaffSide && <div className="h-20 lg:hidden" aria-hidden />}
    </div>
  )
}

function Thumb({ url }) {
  return (
    <div className="h-20 w-20 overflow-hidden rounded-lg bg-paper-2">
      <Img src={url} thumb alt="" className="h-full w-full object-contain mix-blend-multiply" fallback={<PhotoPlaceholder size={22} />} />
    </div>
  )
}
