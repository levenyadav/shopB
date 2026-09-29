import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { IconCheck, IconShoppingBagPlus } from '@tabler/icons-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import { useShop } from '../../context/ShopContext'
import { useCart } from '../../context/CartContext'
import { money } from '../../lib/format'
import { rateForBuyer, round2 } from '../../lib/helpers'
import { Img, PhotoPlaceholder } from '../../components/ui'
import QtyStepper from '../../components/QtyStepper'

// SPEC §6.3 — item detail + add to cart. Buyers see the price for their tier
// (dealer → Dealer Rate, else Rate); purchase rate is never exposed. Items go
// into the client-side cart; the order (a 'pending' row per line) is placed from
// the cart, where rate is locked as rate_at_order (Golden Rules #2, #5). Owner/
// staff only preview. Anonymous browsers may build a cart, then sign in to check
// out.
//
// Opened from a product card, the card's row arrives in router state, so the
// page renders at once and the full row (gallery, description) fills in.
export default function ItemDetail() {
  const { id } = useParams()
  const { state } = useLocation()
  const { role } = useAuth()
  const { currency, categories } = useShop()
  const preview = state?.item?.id === id ? state.item : null
  const [item, setItem] = useState(preview)
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

  if (notFound) {
    return (
      <Notice title="This product isn’t available right now">
        It may have sold out. <Link to="/" className="font-semibold text-peacock hover:underline">See what’s in stock</Link>
      </Notice>
    )
  }
  if (err && !item) {
    return (
      <Notice title="Couldn’t load this product">
        Check your connection and <button type="button" onClick={() => window.location.reload()} className="font-semibold text-peacock hover:underline">try again</button>.
      </Notice>
    )
  }
  if (!item) return <DetailSkeleton />

  const category = categories.find((c) => c.id === item.category_id)
  const price = rateForBuyer(item, role)
  const available = Number(item.quantity)
  const mto = !!item.made_to_order
  const low = !mto && available < Number(item.low_stock_threshold)
  const moq = Math.max(1, Number(item.moq) || 1)
  const isStaffSide = role === 'owner' || role === 'staff'

  return (
    <div className="grid gap-6 md:grid-cols-2 md:gap-10 lg:gap-14">
      <Gallery item={item} />

      <div className="flex flex-col gap-5">
        <div>
          {category && (
            <Link to={`/shop/${category.id}`} className="text-sm text-muted hover:text-ink">{category.name}</Link>
          )}
          <h1 className="mt-1 font-[var(--font-display)] text-2xl font-bold leading-tight text-ink sm:text-3xl">{item.name}</h1>
          <p className="mt-3 flex items-baseline gap-2">
            <span className="fig text-2xl font-semibold text-peacock sm:text-3xl">{money(price)}</span>
            <span className="text-sm text-muted">{role === 'dealer' ? 'dealer price · ' : ''}per piece</span>
          </p>
          <p className="mt-2 text-sm">
            {mto ? <span className="text-ink">Made to order</span>
              : low ? <span className="font-medium text-saffron">Only <span className="fig">{available}</span> left</span>
              : <span className="font-medium text-profit">In stock</span>}
            {moq > 1 && <span className="text-muted"> · Sold in packs of <span className="fig">{moq}</span></span>}
          </p>
        </div>

        {isStaffSide ? (
          <p className="rounded-lg bg-paper-2 px-4 py-3 text-sm text-muted">
            You’re signed in as {role}. This is how buyers see the product — ordering is for customers and dealers.
          </p>
        ) : (
          <PurchaseBar item={item} price={price} available={available} currency={currency} mto={mto} moq={moq} />
        )}

        {item.description && (
          <div className="border-t border-line pt-5">
            <h2 className="mb-2 text-sm font-semibold text-ink">Details</h2>
            <p className="whitespace-pre-line text-[15px] leading-relaxed text-ink/80">{item.description}</p>
          </div>
        )}
      </div>
    </div>
  )
}

// Quantity + Add to cart. Inline on desktop; on phones it's pinned to the bottom
// of the screen so the buyer never scrolls to find it. Quantity always snaps to
// a whole multiple of MOQ, capped at stock (uncapped for made-to-order).
function PurchaseBar({ item, price, available, currency, mto, moq }) {
  const { add } = useCart()
  const belowMoq = !mto && available < moq // not enough stock to meet the minimum order
  const [n, setN] = useState(moq)
  const [added, setAdded] = useState(false)
  const timer = useRef(null)
  useEffect(() => () => clearTimeout(timer.current), [])

  const cap = mto ? Infinity : available
  const amount = round2(price * n)

  function addToCart() {
    add(item, n)
    setAdded(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setAdded(false), 1500)
  }

  if (belowMoq) {
    return (
      <p className="rounded-lg bg-paper-2 px-4 py-3 text-sm text-ink/80">
        Sold in packs of <span className="fig">{moq}</span>, but only <span className="fig">{available}</span> are
        in stock right now. Please check back soon.
      </p>
    )
  }

  return (
    <>
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-card px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:static md:z-auto md:border-0 md:bg-transparent md:p-0">
        <div className="mx-auto flex max-w-7xl items-start gap-3">
          <QtyStepper value={n} moq={moq} cap={cap} onChange={setN} />
          <button
            type="button"
            onClick={addToCart}
            className={`inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-lg px-4 text-[15px] font-semibold text-white transition-colors duration-150 md:max-w-xs ${
              added ? 'bg-profit' : 'bg-peacock hover:bg-peacock-700'
            }`}
          >
            {added
              ? <><IconCheck size={19} aria-hidden /> Added</>
              : <><IconShoppingBagPlus size={19} aria-hidden /> Add · <span className="fig">{money(amount)}</span></>}
          </button>
        </div>
      </div>
      {/* Room for the pinned bar, so it never covers the description. */}
      <div className="h-20 md:hidden" aria-hidden />
    </>
  )
}

// Cover photo + extra images. One swipeable rail (scroll-snap) at every size,
// with thumbnails from sm up. Falls back to a placeholder when there are none.
function Gallery({ item }) {
  const photos = [item.photo_url, ...(item.images || [])].filter(Boolean)
  const rail = useRef(null)
  const [active, setActive] = useState(0)
  const go = (i) => rail.current?.scrollTo({ left: i * rail.current.clientWidth, behavior: 'smooth' })

  if (photos.length === 0) {
    return (
      <div className="-mx-4 aspect-square overflow-hidden sm:mx-0 sm:rounded-xl">
        <PhotoPlaceholder size={56} />
      </div>
    )
  }

  return (
    <div className="space-y-3 md:sticky md:top-24 md:self-start">
      <div className="relative -mx-4 sm:mx-0">
        <div
          ref={rail}
          onScroll={(e) => setActive(Math.round(e.currentTarget.scrollLeft / e.currentTarget.clientWidth))}
          className="no-scrollbar flex snap-x snap-mandatory overflow-x-auto bg-paper-2 sm:rounded-xl"
          aria-label={`${item.name} photos`}
        >
          {photos.map((p, i) => (
            <div key={p + i} className="aspect-square w-full shrink-0 snap-center">
              <Img src={p} eager={i === 0} alt={i === 0 ? item.name : `${item.name}, photo ${i + 1}`}
                   className="h-full w-full object-contain mix-blend-multiply"
                   fallback={<PhotoPlaceholder size={56} />} />
            </div>
          ))}
        </div>
        {photos.length > 1 && (
          <div className="absolute inset-x-0 bottom-2 flex justify-center gap-1.5 sm:hidden" aria-hidden>
            {photos.map((_, i) => (
              <span key={i} className={`h-1.5 rounded-full transition-all duration-150 ${i === active ? 'w-4 bg-ink/70' : 'w-1.5 bg-ink/25'}`} />
            ))}
          </div>
        )}
      </div>
      {photos.length > 1 && (
        <div className="hidden flex-wrap gap-2 sm:flex">
          {photos.map((p, i) => (
            <button
              key={p + i} type="button" onClick={() => go(i)}
              aria-label={`Show photo ${i + 1}`} aria-current={i === active ? 'true' : undefined}
              className={`h-16 w-16 overflow-hidden rounded-lg bg-paper-2 ring-offset-2 transition-shadow duration-150 ${
                i === active ? 'ring-2 ring-ink' : 'hover:ring-1 hover:ring-line'
              }`}
            >
              <Img src={p} thumb alt="" className="h-full w-full object-cover" fallback={<PhotoPlaceholder size={20} />} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function DetailSkeleton() {
  return (
    <div className="grid animate-pulse gap-6 md:grid-cols-2 md:gap-10" aria-hidden>
      <div className="-mx-4 aspect-square bg-paper-2 sm:mx-0 sm:rounded-xl" />
      <div className="space-y-3">
        <div className="h-4 w-24 rounded bg-paper-2" />
        <div className="h-8 w-3/4 rounded bg-paper-2" />
        <div className="h-8 w-28 rounded bg-paper-2" />
        <div className="h-11 w-full rounded-lg bg-paper-2 md:max-w-sm" />
      </div>
      <span className="sr-only" role="status">Loading product…</span>
    </div>
  )
}

function Notice({ title, children }) {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <p className="font-semibold text-ink">{title}</p>
      <p className="mt-1 text-sm text-muted">{children}</p>
    </div>
  )
}
