import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { IconReceipt2 } from '@tabler/icons-react'
import { supabase, fetchIn } from '../../lib/supabase'
import { money, qty, dateTime } from '../../lib/format'
import { shippingFeeFor } from '../../lib/helpers'
import { OrderStatusBadge, Spinner, Img, PhotoPlaceholder } from '../../components/ui'
import { useOrdersTick } from '../../lib/useOrdersTick'

// SPEC §6.3 / §10.2 — buyer's own order list, newest first. RLS (orders_buyer_
// select) already scopes rows to this buyer, so no extra filter is needed.
// Item names are joined; an item that has since gone out of stock/inactive falls
// back to a neutral label because buyer RLS only exposes active, in-stock items.
export default function MyOrders() {
  const [orders, setOrders] = useState(null)
  const [err, setErr] = useState('')
  const tick = useOrdersTick()   // re-read when the shop changes an order

  useEffect(() => {
    let active = true
    async function load() {
      // Buyers can't read the base items table (cost is hidden — Golden Rule #4),
      // so we resolve item name/photo from the shopfront_items view by id. Items
      // now out of stock / inactive aren't in the view → neutral fallback below.
      const { data: rows, error } = await supabase
        .from('orders')
        .select('id, item_id, item_name, quantity, amount, status, notes, buyer_type, created_at, order_group_id')
        .order('created_at', { ascending: false })
      if (!active) return
      if (error) { setErr(error.message); return }

      const ids = [...new Set((rows ?? []).map((o) => o.item_id))]
      const byId = {}
      if (ids.length) {
        const { data: items } = await fetchIn(ids, (chunk) => supabase
          .from('shopfront_items')
          .select('id, name, photo_url')
          .in('id', chunk))
        for (const it of items ?? []) byId[it.id] = it
      }
      // Shipping / packing / other (023), so a card's total is the same figure
      // the order's own page shows. Buyer-safe view — it carries no cost data.
      const billable = (rows ?? []).filter((o) => o.status !== 'pending' && o.status !== 'rejected')
      const billById = {}
      if (billable.length) {
        const { data: bls } = await fetchIn(billable.map((o) => o.id), (chunk) => supabase
          .from('customer_bills')
          .select('order_id, discount_amount, shipping_fee, packing_fee, other_charge')
          .in('order_id', chunk))
        for (const b of bls ?? []) billById[b.order_id] = b
      }

      const withItem = (rows ?? []).map((o) => ({
        ...o, item: byId[o.item_id] || null, bill: billById[o.id] || null,
      }))
      if (active) setOrders(groupOrders(withItem))
    }
    load()
    return () => { active = false }
  }, [tick])

  return (
    <div className="space-y-5">
      <h1 className="font-[var(--font-display)] text-2xl font-bold text-ink sm:text-3xl">My orders</h1>

      {err && <p className="rounded-lg bg-dues/10 px-4 py-3 text-sm text-dues">{err}</p>}

      {orders === null ? (
        <div className="grid place-items-center py-16 text-muted"><Spinner /></div>
      ) : orders.length === 0 ? (
        <div className="flex flex-col items-center py-16 text-center">
          <IconReceipt2 size={38} stroke={1.3} className="text-muted" aria-hidden />
          <p className="mt-3 font-semibold text-ink">No orders yet</p>
          <p className="mt-1 text-sm text-muted">Orders you place will show here with their status.</p>
          <Link to="/" className="mt-5 inline-flex h-11 items-center rounded-lg bg-peacock px-6 text-sm font-semibold text-white transition-colors duration-150 hover:bg-peacock-700">
            Browse the shop
          </Link>
        </div>
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {orders.map((g) => (
            <li key={g.id}>
              <Link
                to={`/orders/${g.id}`}
                className="-mx-2 flex items-center gap-4 rounded-lg px-2 py-3 transition-colors duration-150 hover:bg-paper-2"
              >
                <Thumb url={g.lines[0]?.item?.photo_url} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-ink">{groupTitle(g)}</p>
                  <p className="text-xs text-muted">
                    <span className="fig">{qty(g.totalQty)}</span> pcs · {dateTime(g.created_at)}
                  </p>
                </div>
                <div className="text-right">
                  <p className="fig font-semibold">{money(g.totalAmount)}</p>
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
      g = {
        id: o.id, created_at: o.created_at, lines: [], totalAmount: 0, totalQty: 0,
        status: o.status, buyerType: o.buyer_type, booked: 0, awaitingBill: false,
      }
      byKey.set(key, g)
      groups.push(g)
    }
    g.lines.push(o)
    // A rejected line is never charged, so it adds nothing to the total. Fees
    // only exist once the shop has approved and billed the line (023).
    if (o.status !== 'rejected') {
      const b = o.bill
      const fees = Number(b?.shipping_fee || 0) + Number(b?.packing_fee || 0) + Number(b?.other_charge || 0)
      g.booked += fees
      if (!b) g.awaitingBill = true
      g.totalAmount += (Number(o.amount) || 0) - Number(b?.discount_amount || 0) + fees
      g.totalQty += Number(o.quantity) || 0
    }
    // Show the least-progressed status so the buyer sees the group as still open.
    if (STATUS_RANK.indexOf(o.status) < STATUS_RANK.indexOf(g.status)) g.status = o.status
  }
  // A dealer's flat shipping & handling isn't billed until the shop confirms, so
  // add the expected fee here too — the card total must equal the figure the
  // order's own page shows (MyOrderDetail applies the identical rule).
  for (const g of groups) {
    if (g.booked === 0 && g.awaitingBill) g.totalAmount += shippingFeeFor(g.buyerType)
  }
  return groups
}

function Thumb({ url }) {
  return (
    <div className="h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-paper-2">
      <Img src={url} thumb alt="" className="h-full w-full object-contain mix-blend-multiply" fallback={<PhotoPlaceholder size={22} />} />
    </div>
  )
}
