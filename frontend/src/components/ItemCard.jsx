import { Link } from 'react-router-dom'
import { IconPlus, IconCheck } from '@tabler/icons-react'
import { useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { useShop } from '../context/ShopContext'
import { useCart } from '../context/CartContext'
import { money } from '../lib/format'
import { rateForBuyer } from '../lib/helpers'
import { Img, PhotoPlaceholder } from './ui'

// One product tile on the shopfront (SPEC §6.3): image → name → price → one
// line of MOQ / stock status → Add. The price is the one this viewer pays —
// dealers see Dealer Rate, everyone else the Rate. Purchase rate is NEVER shown.
//
// The name's link is stretched over the whole tile (after:inset-0), so the tile
// is one big target while the Add button stays a real sibling button — never a
// <button> nested inside an <a>.
export default function ItemCard({ item, priority = false }) {
  const { role } = useAuth()
  const { currency } = useShop()
  const { add } = useCart()
  const [added, setAdded] = useState(false)
  const price = rateForBuyer(item, role)
  const mto = !!item.made_to_order
  // Made-to-order items are always orderable regardless of stock; a normal item
  // is "low" only when its real stock dips below the threshold.
  const low = !mto && Number(item.quantity) < Number(item.low_stock_threshold)
  const moq = Math.max(1, Number(item.moq) || 1)
  // Owner/staff preview the shopfront but don't order; a normal item can only be
  // quick-added when stock covers at least one full MOQ pack (orders go in whole
  // multiples of MOQ). Made-to-order is produced on demand, so always orderable.
  const canAdd = role !== 'owner' && role !== 'staff' && (mto || Number(item.quantity) >= moq)

  function onAdd() {
    add(item, moq)
    setAdded(true)
    setTimeout(() => setAdded(false), 1500)
  }

  return (
    <article className="group relative flex flex-col rounded-xl has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-offset-4 has-[a:focus-visible]:outline-peacock">
      <div className="relative aspect-square overflow-hidden rounded-xl bg-paper-2">
        <Img
          src={item.photo_url}
          thumb
          eager={priority}
          fetchPriority={priority ? 'high' : undefined}
          alt=""
          // object-contain so the whole product shows; multiply melts a
          // photo's white studio background into the tile.
          className="h-full w-full object-contain mix-blend-multiply transition-opacity duration-150 group-hover:opacity-90"
          fallback={<PhotoPlaceholder size={36} />}
        />
      </div>

      <div className="flex flex-1 flex-col pt-2.5">
        <h3 className="line-clamp-2 text-sm leading-snug text-ink sm:text-[15px]">
          <Link
            to={`/item/${item.id}`}
            state={{ item }}
            className="outline-none after:absolute after:inset-0 after:rounded-xl"
          >
            {item.name}
          </Link>
        </h3>
        <div className="mt-auto flex items-end justify-between gap-2 pt-1.5">
          <div className="min-w-0">
            <p className="fig text-base font-semibold text-peacock sm:text-[17px]">
              {money(price).replace('₹', currency)}
            </p>
            <Meta mto={mto} low={low} moq={moq} />
          </div>
          {canAdd && (
            <button
              type="button"
              onClick={onAdd}
              aria-label={moq > 1 ? `Add ${moq} × ${item.name} to cart` : `Add ${item.name} to cart`}
              className={`relative z-10 grid h-11 w-11 shrink-0 place-items-center rounded-full border transition-colors duration-150 ${
                added
                  ? 'border-profit bg-profit text-white'
                  : 'border-line bg-card text-peacock hover:border-peacock hover:bg-peacock hover:text-white'
              }`}
            >
              {added ? <IconCheck size={20} aria-hidden /> : <IconPlus size={20} aria-hidden />}
            </button>
          )}
        </div>
      </div>
    </article>
  )
}

// One quiet line under the price: the minimum pack, and stock status only when
// it matters (low / made to order). Nothing when there's nothing to say.
function Meta({ mto, low, moq }) {
  const parts = []
  if (moq > 1) parts.push(<span key="moq">Min <span className="fig">{moq}</span> pcs</span>)
  if (mto) parts.push(<span key="s">Made to order</span>)
  else if (low) parts.push(<span key="s" className="text-saffron">Few left</span>)
  if (parts.length === 0) return null
  return (
    <p className="mt-0.5 truncate text-xs text-muted">
      {parts.reduce((acc, p, i) => (i ? [...acc, ' · ', p] : [p]), [])}
    </p>
  )
}
