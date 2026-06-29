import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { IconPhoto, IconReceipt2 } from '@tabler/icons-react'
import { supabase } from '../../lib/supabase'
import { useShop } from '../../context/ShopContext'
import { money, qty, dateTime } from '../../lib/format'
import { OrderStatusBadge, Spinner } from '../../components/ui'

// SPEC §6.3 / §10.2 — buyer's own order list, newest first. RLS (orders_buyer_
// select) already scopes rows to this buyer, so no extra filter is needed.
// Item names are joined; an item that has since gone out of stock/inactive falls
// back to a neutral label because buyer RLS only exposes active, in-stock items.
export default function MyOrders() {
  const { currency } = useShop()
  const [orders, setOrders] = useState(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    let active = true
    supabase
      .from('orders')
      .select('id, quantity, amount, status, notes, created_at, item:items(name, photo_url)')
      .order('created_at', { ascending: false })
      .then(({ data, error }) => {
        if (!active) return
        if (error) setErr(error.message)
        else setOrders(data ?? [])
      })
    return () => { active = false }
  }, [])

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-[var(--font-display)] text-3xl font-bold">My orders</h1>
        <p className="text-muted">Track every order you’ve placed and its status.</p>
      </div>

      {err && <p className="rounded-lg bg-dues/10 px-4 py-3 text-sm text-dues">{err}</p>}

      {orders === null ? (
        <div className="grid place-items-center py-16 text-muted"><Spinner /></div>
      ) : orders.length === 0 ? (
        <div className="grid place-items-center gap-3 rounded-2xl border border-dashed border-line py-16 text-center text-muted">
          <IconReceipt2 size={38} stroke={1.3} />
          <p>No orders yet.</p>
          <Link to="/" className="font-semibold text-peacock hover:underline">Browse the shop →</Link>
        </div>
      ) : (
        <ul className="space-y-3">
          {orders.map((o) => (
            <li key={o.id}>
              <Link
                to={`/orders/${o.id}`}
                className="flex items-center gap-4 rounded-2xl border border-line bg-card p-3 transition hover:shadow-sm"
              >
                <Thumb url={o.item?.photo_url} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-ink">{o.item?.name || 'Item'}</p>
                  <p className="text-xs text-muted">
                    <span className="fig">{qty(o.quantity)}</span> pcs · {dateTime(o.created_at)}
                  </p>
                </div>
                <div className="text-right">
                  <p className="fig font-semibold">{money(o.amount).replace('₹', currency)}</p>
                  <div className="mt-1"><OrderStatusBadge status={o.status} /></div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Thumb({ url }) {
  return (
    <div className="h-14 w-14 shrink-0 overflow-hidden rounded-xl border border-line bg-paper-2">
      {url ? (
        <img src={url} alt="" className="h-full w-full object-cover" />
      ) : (
        <div className="grid h-full w-full place-items-center text-muted"><IconPhoto size={22} /></div>
      )}
    </div>
  )
}
