import { Link } from 'react-router-dom'
import { IconPhoto, IconShoppingCartPlus, IconCheck } from '@tabler/icons-react'
import { useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { useShop } from '../context/ShopContext'
import { useCart } from '../context/CartContext'
import { money } from '../lib/format'
import { rateForBuyer } from '../lib/helpers'
import { Badge } from './ui'

// One product tile on the shopfront (SPEC §6.3). Shows photo, name, category and
// the price the viewer pays — dealers see Dealer Rate, everyone else the Rate.
// Purchase rate is NEVER shown here. Low stock gets a "Limited Stock" ribbon.
export default function ItemCard({ item, categoryName }) {
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

  function onAdd(e) {
    e.preventDefault()  // the tile is a Link — don't navigate
    e.stopPropagation()
    add(item, moq)
    setAdded(true)
    setTimeout(() => setAdded(false), 1200)
  }

  return (
    <Link
      to={`/item/${item.id}`}
      className="group flex flex-col overflow-hidden rounded-lg border border-line bg-card transition hover:-translate-y-0.5 hover:border-ink/25"
    >
      <div className="relative aspect-square overflow-hidden bg-paper-2">
        {item.photo_url ? (
          <img
            src={item.photo_url}
            alt={item.name}
            // object-contain (not cover) so landscape/portrait photos show in full
            // inside the square tile instead of being cropped; the paper-2 bg fills
            // the letterbox area.
            className="h-full w-full object-contain transition group-hover:scale-105"
          />
        ) : (
          <div className="grid h-full w-full place-items-center text-muted">
            <IconPhoto size={40} stroke={1.3} />
          </div>
        )}
        {mto ? (
          <span className="absolute left-2 top-2">
            <Badge tone="peacock">Make to Order</Badge>
          </span>
        ) : low && (
          <span className="absolute left-2 top-2">
            <Badge tone="saffron">Limited Stock</Badge>
          </span>
        )}
        {role === 'dealer' && (
          <span className="absolute right-2 top-2">
            <Badge tone="peacock">Dealer rate</Badge>
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-1 p-3">
        <p className="text-[11px] uppercase tracking-wide text-muted">
          {categoryName || item.category?.name || ' '}
        </p>
        <p className="line-clamp-2 font-medium text-ink">{item.name}</p>
        <div className="mt-auto flex items-center justify-between gap-2 pt-1">
          <span className="fig text-lg font-bold text-peacock">
            {money(price).replace('₹', currency)}
          </span>
          {canAdd && (
            <button
              type="button"
              onClick={onAdd}
              aria-label={`Add ${item.name} to cart`}
              className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg border transition ${
                added
                  ? 'border-profit bg-profit/10 text-profit'
                  : 'border-line bg-card text-muted hover:border-peacock hover:text-peacock'
              }`}
            >
              {added ? <IconCheck size={18} /> : <IconShoppingCartPlus size={18} />}
            </button>
          )}
        </div>
      </div>
    </Link>
  )
}
