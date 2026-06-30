import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { IconSearch, IconInbox } from '@tabler/icons-react'
import { supabase } from '../../lib/supabase'
import { useShop } from '../../context/ShopContext'
import { money, qty, dateTime } from '../../lib/format'
import { OrderStatusBadge, InProcessBadge, IN_PROCESS_STATUSES, Badge, Spinner, PhotoThumb } from '../../components/ui'

// SPEC §6.4 — Order Management. All orders, newest first, with filters. The
// owner taps through to approve/reject. Pending orders are surfaced first with a
// count so nothing waits unseen.
const STATUS_FILTERS = [
  ['', 'All'], ['pending', 'Pending'], ['approved', 'Approved'],
  ['packed', 'Packed'], ['delivered', 'Done'], ['rejected', 'Rejected'],
]

export default function OrderManagement() {
  const { currency } = useShop()
  const [orders, setOrders] = useState(null)
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [buyerType, setBuyerType] = useState('')

  async function load() {
    setErr('')
    const { data, error } = await supabase
      .from('orders')
      .select(
        'id, quantity, amount, status, buyer_type, created_at, ' +
          'item:items(name, photo_url), buyer:profiles!orders_buyer_id_fkey(full_name, phone)',
      )
      .order('created_at', { ascending: false })
    if (error) setErr(error.message)
    else setOrders(data ?? [])
  }
  useEffect(() => { load() }, [])

  // Live updates: a new order, an approval, or staff packing/delivering all
  // change the orders table — re-fetch so statuses (and the "In process" pill)
  // stay current without a manual refresh.
  useEffect(() => {
    const channel = supabase
      .channel('owner-order-list')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, load)
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [])

  const pendingCount = useMemo(
    () => (orders ? orders.filter((o) => o.status === 'pending').length : 0),
    [orders],
  )

  const filtered = useMemo(() => {
    if (!orders) return []
    const needle = q.trim().toLowerCase()
    return orders.filter((o) => {
      if (status === 'delivered'
        ? !['delivered', 'picked_up'].includes(o.status)
        : status && o.status !== status) return false
      if (buyerType && o.buyer_type !== buyerType) return false
      if (needle) {
        const hay = `${o.item?.name || ''} ${o.buyer?.full_name || ''} ${o.buyer?.phone || ''}`.toLowerCase()
        if (!hay.includes(needle)) return false
      }
      return true
    })
  }, [orders, q, status, buyerType])

  return (
    <div className="space-y-5">
      {/* Pending summary */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="rounded-lg border border-line bg-card px-5 py-3">
          <p className="text-xs text-muted">Orders waiting for approval</p>
          <p className="fig text-2xl font-bold text-saffron">{pendingCount}</p>
        </div>
      </div>

      {/* Filters */}
      <div className="grid gap-3 rounded-lg border border-line bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="relative sm:col-span-2 lg:col-span-2">
          <IconSearch size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search buyer or item…"
            className="w-full rounded-lg border border-line bg-card py-2.5 pl-9 pr-3 text-ink outline-none focus:border-peacock focus:ring-1 focus:ring-peacock"
          />
        </div>
        <select value={buyerType} onChange={(e) => setBuyerType(e.target.value)}
                className="rounded-lg border border-line bg-card px-3 py-2.5 text-ink outline-none focus:border-peacock focus:ring-1 focus:ring-peacock">
          <option value="">All buyers</option>
          <option value="customer">Customers</option>
          <option value="dealer">Dealers</option>
        </select>
        <div className="flex flex-wrap gap-1.5 sm:col-span-2 lg:col-span-4">
          {STATUS_FILTERS.map(([key, label]) => (
            <button
              key={key} type="button" onClick={() => setStatus(key)}
              className={`rounded-full border px-3 py-1.5 text-sm font-medium transition ${
                status === key ? 'border-peacock bg-peacock text-white' : 'border-line bg-card text-muted hover:text-ink'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {err && <p className="rounded-lg bg-dues/10 px-4 py-3 text-sm text-dues">{err}</p>}

      {orders === null ? (
        <div className="grid place-items-center py-16 text-muted"><Spinner /></div>
      ) : filtered.length === 0 ? (
        <div className="grid place-items-center gap-3 rounded-lg border border-dashed border-line py-16 text-center text-muted">
          <IconInbox size={38} stroke={1.3} />
          <p>No orders here yet.</p>
        </div>
      ) : (
        <ul className="space-y-2.5">
          {filtered.map((o) => (
            <li key={o.id}>
              <Link
                to={`/owner/orders/${o.id}`}
                className="flex items-center gap-4 rounded-lg border border-line bg-card p-3 transition hover:border-ink/20"
              >
                <PhotoThumb url={o.item?.photo_url} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-ink">{o.item?.name || 'Item'}</p>
                  <p className="truncate text-xs text-muted">
                    {o.buyer?.full_name || 'Buyer'}
                    <Badge tone={o.buyer_type === 'dealer' ? 'peacock' : 'muted'} className="ml-1.5">
                      {o.buyer_type}
                    </Badge>
                    <span className="ml-2">{dateTime(o.created_at)}</span>
                  </p>
                </div>
                <div className="text-right">
                  <p className="fig font-semibold">{money(o.amount).replace('₹', currency)}</p>
                  <p className="text-xs text-muted"><span className="fig">{qty(o.quantity)}</span> pcs</p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <OrderStatusBadge status={o.status} />
                  {IN_PROCESS_STATUSES.includes(o.status) && <InProcessBadge />}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

