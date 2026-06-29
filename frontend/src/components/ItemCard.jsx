import { Link } from 'react-router-dom'
import { IconPhoto } from '@tabler/icons-react'
import { useAuth } from '../context/AuthContext'
import { useShop } from '../context/ShopContext'
import { money } from '../lib/format'
import { rateForBuyer } from '../lib/helpers'
import { Badge } from './ui'

// One product tile on the shopfront (SPEC §6.3). Shows photo, name, category and
// the price the viewer pays — dealers see Dealer Rate, everyone else the Rate.
// Purchase rate is NEVER shown here. Low stock gets a "Limited Stock" ribbon.
export default function ItemCard({ item }) {
  const { role } = useAuth()
  const { currency } = useShop()
  const price = rateForBuyer(item, role)
  const low = Number(item.quantity) < Number(item.low_stock_threshold)

  return (
    <Link
      to={`/item/${item.id}`}
      className="group flex flex-col overflow-hidden rounded-2xl border border-line bg-card transition hover:-translate-y-0.5 hover:shadow-md"
    >
      <div className="relative aspect-square overflow-hidden bg-paper-2">
        {item.photo_url ? (
          <img
            src={item.photo_url}
            alt={item.name}
            className="h-full w-full object-cover transition group-hover:scale-105"
          />
        ) : (
          <div className="grid h-full w-full place-items-center text-muted">
            <IconPhoto size={40} stroke={1.3} />
          </div>
        )}
        {low && (
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
          {item.category?.name || ' '}
        </p>
        <p className="line-clamp-2 font-medium text-ink">{item.name}</p>
        <p className="mt-auto pt-1">
          <span className="fig text-lg font-bold text-peacock">
            {money(price).replace('₹', currency)}
          </span>
        </p>
      </div>
    </Link>
  )
}
