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
    async function load() {
      // Buyers can't read the base items table (cost is hidden — Golden Rule #4),
      // so we resolve item name/photo from the shopfront_items view by id. Items
      // now out of stock / inactive aren't in the view → neutral fallback below.
      const { data: rows, error } = await supabase
        .from('orders')
        .select('id, item_id, item_name, quantity, amount, status, notes, created_at, order_group_id')
        .order('created_at', { ascending: false })
      if (!active) return
      if (error) { setErr(error.message); return }

      const ids = [...new Set((rows ?? []).map((o) => o.item_id))]
      const byId = {}
      if (ids.length) {
        const { data: items } = await supabase
          .from('shopfront_items')
          .select('id, name, photo_url')
          .in('id', ids)
        for (const it of items ?? []) byId[it.id] = it
      }
      const withItem = (rows ?? []).map((o) => ({ ...o, item: byId[o.item_id] || null }))
      if (active) setOrders(groupOrders(withItem))
    }
    load()
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
        <div className="grid place-items-center gap-3 rounded-lg border border-dashed border-line py-16 text-center text-muted">
          <IconReceipt2 size={38} stroke={1.3} />
          <p>No orders yet.</p>
          <Link to="/" className="font-semibold text-peacock hover:underline">Browse the shop →</Link>
        </div>
      ) : (
        <ul className="space-y-3">
          {orders.map((g) => (
            <li key={g.id}>
              <Link
                to={`/orders/${g.id}`}
                className="flex items-center gap-4 rounded-lg border border-line bg-card p-3 transition hover:border-ink/20"
              >
                <Thumb url={g.lines[0]?.item?.photo_url} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-ink">{groupTitle(g)}</p>
                  <p className="text-xs text-muted">
                    <span className="fig">{qty(g.totalQty)}</span> pcs · {dateTime(g.created_at)}
                  </p>
                </div>
                <div className="text-right">
                  <p className="fig font-semibold">{money(g.totalAmount).replace('₹', currency)}</p>
                  <div className="mt-1"><OrderStatusBadge status={g.status} audience="buyer" /></div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// Buyer-facing label for a grouped order: the first item's name, plus "+N more"
// when the cart had several items.
function groupTitle(g) {
  const first = g.lines[0]?.item?.name || g.lines[0]?.item_name || 'Item'
  return g.lines.length > 1 ? `${first} +${g.lines.length - 1} more` : first
}

// Collapse order rows that share an order_group_id into one card (a cart). Legacy
// rows with a null group_id stand alone (a group of one). Order is preserved from
// the newest-first input, so the link target is the group's first (newest) row.
const STATUS_RANK = ['pending', 'approved', 'packed', 'delivered', 'picked_up', 'rejected']
function groupOrders(rows) {
  const groups = []
  const byKey = new Map()
  for (const o of rows) {
    const key = o.order_group_id || o.id
    let g = byKey.get(key)
    if (!g) {
      g = { id: o.id, created_at: o.created_at, lines: [], totalAmount: 0, totalQty: 0, status: o.status }
      byKey.set(key, g)
      groups.push(g)
    }
    g.lines.push(o)
    g.totalAmount += Number(o.amount) || 0
    g.totalQty += Number(o.quantity) || 0
    // Show the least-progressed status so the buyer sees the group as still open.
    if (STATUS_RANK.indexOf(o.status) < STATUS_RANK.indexOf(g.status)) g.status = o.status
  }
  return groups
}

function Thumb({ url }) {
  return (
    <div className="h-14 w-14 shrink-0 overflow-hidden rounded-lg border border-line bg-paper-2">
      {url ? (
        <img src={url} alt="" className="h-full w-full object-cover" />
      ) : (
        <div className="grid h-full w-full place-items-center text-muted"><IconPhoto size={22} /></div>
      )}
    </div>
  )
}
