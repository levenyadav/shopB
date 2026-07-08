import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  IconPhoto, IconArrowLeft, IconMinus, IconPlus, IconCircleCheck, IconShoppingCartPlus,
} from '@tabler/icons-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import { useShop } from '../../context/ShopContext'
import { useCart } from '../../context/CartContext'
import { money } from '../../lib/format'
import { rateForBuyer, round2 } from '../../lib/helpers'
import { Button, Textarea, Badge, Spinner } from '../../components/ui'

// SPEC §6.3 — item detail + add to cart. Buyers see the price for their tier
// (dealer → Dealer Rate, else Rate); purchase rate is never exposed. Items go
// into the client-side cart; the order (a 'pending' row per line) is placed from
// the cart, where rate is locked as rate_at_order (Golden Rules #2, #5). Owner/
// staff only preview. Anonymous browsers may build a cart, then sign in to check
// out.
export default function ItemDetail() {
  const { id } = useParams()
  const { role } = useAuth()
  const { currency, categories } = useShop()
  const [item, setItem] = useState(null)
  const [err, setErr] = useState('')
  const [notFound, setNotFound] = useState(false)

  // shopfront_items: column-safe view (no purchase_rate — Golden Rule #4).
  useEffect(() => {
    let active = true
    supabase
      .from('shopfront_items')
      .select('id, name, quantity, rate, dealer_rate, low_stock_threshold, photo_url, category_id, moq, description, tags, images, made_to_order')
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

  const categoryName = item && categories.find((c) => c.id === item.category_id)?.name

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
  const isStaffSide = role === 'owner' || role === 'staff'

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-ink">
        <IconArrowLeft size={17} /> Back to shop
      </Link>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Photo gallery */}
        <Gallery item={item} />

        {/* Details + order */}
        <div className="flex flex-col gap-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted">{categoryName}</p>
            <h1 className="font-[var(--font-display)] text-3xl font-bold">{item.name}</h1>
            {item.tags?.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {item.tags.map((t) => (
                  <span key={t} className="rounded-full bg-paper-2 px-2.5 py-0.5 text-xs font-medium text-muted">#{t}</span>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-end gap-3">
            <span className="fig text-3xl font-bold text-peacock">
              {money(price).replace('₹', currency)}
            </span>
            {role === 'dealer' && <Badge tone="peacock">Dealer rate</Badge>}
            {item.made_to_order
              ? <Badge tone="peacock">Make to Order</Badge>
              : available < Number(item.low_stock_threshold)
                ? <Badge tone="saffron">Limited Stock</Badge>
                : <Badge tone="profit">In stock</Badge>}
          </div>

          {item.description && (
            <p className="whitespace-pre-line text-sm leading-relaxed text-ink/80">{item.description}</p>
          )}

          {isStaffSide ? (
            <p className="rounded-lg border border-line bg-paper-2 px-4 py-3 text-sm text-muted">
              You’re signed in as {role}. Ordering is for customers and dealers — this is how your shopfront looks to them.
            </p>
          ) : (
            <OrderBox item={item} price={price} available={available} currency={currency} mto={!!item.made_to_order} />
          )}
        </div>
      </div>
    </div>
  )
}

function OrderBox({ item, price, available, currency, mto }) {
  const { add } = useCart()
  const moq = Math.max(1, Number(item.moq) || 1)
  // Made-to-order items are produced on demand — no stock ceiling, and the MOQ
  // can always be met regardless of the placeholder on-hand quantity.
  const belowMoq = !mto && available < moq // not enough stock to meet the minimum order
  const [n, setN] = useState(moq)
  const [note, setNote] = useState('')
  const [added, setAdded] = useState(false)

  const clamp = (v) => Math.max(moq, mto ? v : Math.min(available, v))
  const amount = round2(price * n)

  function addToCart() {
    add(item, n, note)
    setAdded(true)
  }

  if (added) {
    return (
      <div className="rounded-lg border border-profit/30 bg-profit/10 p-5">
        <div className="flex items-center gap-2 text-profit">
          <IconCircleCheck size={22} />
          <p className="font-semibold">Added to cart</p>
        </div>
        <p className="mt-1 text-sm text-ink/80">
          {n} × {item.name} (<span className="fig">{money(amount).replace('₹', currency)}</span>) is in your cart.
        </p>
        <div className="mt-3 flex flex-wrap gap-4">
          <Link to="/cart" className="text-sm font-semibold text-peacock hover:underline">
            Go to cart →
          </Link>
          <button type="button" onClick={() => setAdded(false)} className="text-sm font-medium text-muted hover:text-ink">
            Add more
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4 rounded-lg border border-line bg-card p-5">
      {belowMoq && (
        <p className="rounded-lg bg-saffron/10 px-3 py-2 text-sm text-saffron">
          This item needs a minimum order of <span className="fig">{moq}</span> pcs, but only{' '}
          <span className="fig">{available}</span> are in stock. Please check back soon.
        </p>
      )}

      {/* Quantity stepper */}
      <div>
        <p className="mb-1.5 text-sm font-medium">How many?</p>
        <div className="flex items-center gap-3">
          <div className="inline-flex items-center rounded-lg border border-line">
            <button type="button" onClick={() => setN((v) => clamp(v - 1))}
                    className="grid h-10 w-10 place-items-center text-muted hover:text-ink disabled:opacity-40" aria-label="Less"
                    disabled={belowMoq}>
              <IconMinus size={18} />
            </button>
            <input
              type="number" min={moq} max={mto ? undefined : available} value={n}
              onChange={(e) => setN(clamp(Number(e.target.value) || moq))}
              disabled={belowMoq}
              className="fig w-14 border-x border-line py-2 text-center outline-none"
            />
            <button type="button" onClick={() => setN((v) => clamp(v + 1))}
                    className="grid h-10 w-10 place-items-center text-muted hover:text-ink disabled:opacity-40" aria-label="More"
                    disabled={belowMoq}>
              <IconPlus size={18} />
            </button>
          </div>
          {mto
            ? <span className="text-sm text-muted">Made to order</span>
            : <span className="text-sm text-muted"><span className="fig">{available}</span> available</span>}
        </div>
        {moq > 1 && (
          <p className="mt-1.5 text-xs text-muted">Minimum order: <span className="fig">{moq}</span> pcs</p>
        )}
      </div>

      <Textarea
        label="Note for the shop (optional)"
        rows={2} value={note} onChange={(e) => setNote(e.target.value)}
        placeholder="e.g. need by Friday, gift wrap…"
      />

      <div className="flex items-center justify-between border-t border-line pt-3">
        <span className="text-sm text-muted">Subtotal</span>
        <span className="fig text-xl font-bold">{money(amount).replace('₹', currency)}</span>
      </div>

      <Button onClick={addToCart} disabled={belowMoq} className="w-full">
        <IconShoppingCartPlus size={18} /> Add to cart
      </Button>
      <p className="text-center text-xs text-muted">
        Stock is held only after the shop confirms your order.
      </p>
    </div>
  )
}

// Cover photo + extra gallery images. The cover (photo_url) leads; tapping a
// thumbnail swaps the main image. Falls back to a placeholder when there are none.
function Gallery({ item }) {
  const photos = [item.photo_url, ...(item.images || [])].filter(Boolean)
  const [active, setActive] = useState(0)
  const main = photos[Math.min(active, photos.length - 1)]

  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-lg border border-line bg-paper-2">
        <div className="aspect-square">
          {main ? (
            <img src={main} alt={item.name} className="h-full w-full object-cover" />
          ) : (
            <div className="grid h-full w-full place-items-center text-muted">
              <IconPhoto size={56} stroke={1.2} />
            </div>
          )}
        </div>
      </div>
      {photos.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {photos.map((p, i) => (
            <button
              key={i} type="button" onClick={() => setActive(i)}
              className={`h-16 w-16 overflow-hidden rounded-md border bg-paper-2 transition ${
                i === active ? 'border-peacock ring-1 ring-peacock' : 'border-line hover:border-ink/25'
              }`}
            >
              <img src={p} alt="" className="h-full w-full object-cover" />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function Empty({ children }) {
  return (
    <div className="mx-auto max-w-md rounded-lg border border-dashed border-line p-10 text-center text-muted">
      {children}
    </div>
  )
}
