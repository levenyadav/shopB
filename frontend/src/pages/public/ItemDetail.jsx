import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  IconPhoto, IconArrowLeft, IconMinus, IconPlus, IconCircleCheck, IconLogin2,
} from '@tabler/icons-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import { useShop } from '../../context/ShopContext'
import { money } from '../../lib/format'
import { rateForBuyer, round2 } from '../../lib/helpers'
import { Button, Textarea, Badge, Spinner } from '../../components/ui'

// SPEC §6.3 — item detail + place order. Buyers see the price for their tier
// (dealer → Dealer Rate, else Rate); purchase rate is never exposed. Placing an
// order inserts a 'pending' row only — stock does NOT move until the owner
// approves (Golden Rules #2, #5: rate is locked here as rate_at_order).
export default function ItemDetail() {
  const { id } = useParams()
  const { role, profile } = useAuth()
  const { shopId, currency } = useShop()
  const [item, setItem] = useState(null)
  const [err, setErr] = useState('')
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    let active = true
    supabase
      .from('items')
      .select(
        'id, name, quantity, rate, dealer_rate, low_stock_threshold, photo_url, ' +
          'is_active, category:categories(name)',
      )
      .eq('id', id)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!active) return
        if (error) setErr(error.message)
        else if (!data) setNotFound(true)
        else setItem(data)
      })
    return () => { active = false }
  }, [id])

  if (notFound) {
    return (
      <Empty>
        This item isn’t available right now. <Link to="/" className="font-medium text-peacock hover:underline">Back to the shop</Link>.
      </Empty>
    )
  }
  if (err) return <Empty>{err}</Empty>
  if (!item) return <div className="grid place-items-center py-20 text-muted"><Spinner /></div>

  const price = rateForBuyer(item, role)
  const available = Number(item.quantity)
  const isBuyer = role === 'customer' || role === 'dealer'

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-ink">
        <IconArrowLeft size={17} /> Back to shop
      </Link>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Photo */}
        <div className="overflow-hidden rounded-2xl border border-line bg-paper-2">
          <div className="aspect-square">
            {item.photo_url ? (
              <img src={item.photo_url} alt={item.name} className="h-full w-full object-cover" />
            ) : (
              <div className="grid h-full w-full place-items-center text-muted">
                <IconPhoto size={56} stroke={1.2} />
              </div>
            )}
          </div>
        </div>

        {/* Details + order */}
        <div className="flex flex-col gap-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted">{item.category?.name}</p>
            <h1 className="font-[var(--font-display)] text-3xl font-bold">{item.name}</h1>
          </div>

          <div className="flex items-end gap-3">
            <span className="fig text-3xl font-bold text-peacock">
              {money(price).replace('₹', currency)}
            </span>
            {role === 'dealer' && <Badge tone="peacock">Dealer rate</Badge>}
            {available < Number(item.low_stock_threshold)
              ? <Badge tone="saffron">Limited Stock</Badge>
              : <Badge tone="profit">In stock</Badge>}
          </div>

          {isBuyer ? (
            <OrderBox
              item={item} price={price} available={available}
              shopId={shopId} buyerId={profile.id} buyerType={role} currency={currency}
            />
          ) : role === 'owner' || role === 'staff' ? (
            <p className="rounded-xl border border-line bg-paper-2 px-4 py-3 text-sm text-muted">
              You’re signed in as {role}. Ordering is for customers and dealers — this is how your shopfront looks to them.
            </p>
          ) : (
            <Link
              to="/login"
              className="inline-flex w-fit items-center gap-2 rounded-lg bg-peacock px-5 py-3 font-semibold text-white hover:bg-peacock-700"
            >
              <IconLogin2 size={19} /> Sign in to place an order
            </Link>
          )}
        </div>
      </div>
    </div>
  )
}

function OrderBox({ item, price, available, shopId, buyerId, buyerType, currency }) {
  const [n, setN] = useState(1)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [done, setDone] = useState(false)

  const clamp = (v) => Math.max(1, Math.min(available, v))
  const amount = round2(price * n)

  async function placeOrder() {
    setBusy(true); setErr('')
    const { error } = await supabase.from('orders').insert({
      shop_id: shopId,
      item_id: item.id,
      buyer_id: buyerId,
      buyer_type: buyerType,
      quantity: n,
      rate_at_order: round2(price),
      amount,
      notes: note.trim() || null,
    })
    setBusy(false)
    if (error) { setErr(error.message); return }
    setDone(true)
  }

  if (done) {
    return (
      <div className="rounded-2xl border border-profit/30 bg-profit/10 p-5">
        <div className="flex items-center gap-2 text-profit">
          <IconCircleCheck size={22} />
          <p className="font-semibold">Order placed</p>
        </div>
        <p className="mt-1 text-sm text-ink/80">
          {n} × {item.name} for <span className="fig">{money(amount).replace('₹', currency)}</span>.
          The shop will review and confirm it shortly.
        </p>
        <Link to="/orders" className="mt-3 inline-block text-sm font-semibold text-peacock hover:underline">
          Track my order →
        </Link>
      </div>
    )
  }

  return (
    <div className="space-y-4 rounded-2xl border border-line bg-card p-5">
      {/* Quantity stepper */}
      <div>
        <p className="mb-1.5 text-sm font-medium">How many?</p>
        <div className="flex items-center gap-3">
          <div className="inline-flex items-center rounded-lg border border-line">
            <button type="button" onClick={() => setN((v) => clamp(v - 1))}
                    className="grid h-10 w-10 place-items-center text-muted hover:text-ink" aria-label="Less">
              <IconMinus size={18} />
            </button>
            <input
              type="number" min={1} max={available} value={n}
              onChange={(e) => setN(clamp(Number(e.target.value) || 1))}
              className="fig w-14 border-x border-line py-2 text-center outline-none"
            />
            <button type="button" onClick={() => setN((v) => clamp(v + 1))}
                    className="grid h-10 w-10 place-items-center text-muted hover:text-ink" aria-label="More">
              <IconPlus size={18} />
            </button>
          </div>
          <span className="text-sm text-muted"><span className="fig">{available}</span> available</span>
        </div>
      </div>

      <Textarea
        label="Note for the shop (optional)"
        rows={2} value={note} onChange={(e) => setNote(e.target.value)}
        placeholder="e.g. need by Friday, gift wrap…"
      />

      <div className="flex items-center justify-between border-t border-line pt-3">
        <span className="text-sm text-muted">Total</span>
        <span className="fig text-xl font-bold">{money(amount).replace('₹', currency)}</span>
      </div>

      {err && <p className="rounded-lg bg-dues/10 px-3 py-2 text-sm text-dues">{err}</p>}

      <Button onClick={placeOrder} disabled={busy || available < 1} className="w-full">
        {busy ? <><Spinner /> Placing…</> : 'Place order'}
      </Button>
      <p className="text-center text-xs text-muted">
        Stock is held only after the shop confirms your order.
      </p>
    </div>
  )
}

function Empty({ children }) {
  return (
    <div className="mx-auto max-w-md rounded-2xl border border-dashed border-line p-10 text-center text-muted">
      {children}
    </div>
  )
}
