import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { IconSearch, IconInbox } from '@tabler/icons-react'
import { supabase, fetchAll } from '../../lib/supabase'
import { money, qty, dateTime } from '../../lib/format'
import { OrderStatusBadge, InProcessBadge, IN_PROCESS_STATUSES, Badge, Spinner, PhotoThumb } from '../../components/ui'

// SPEC §6.4 — Order Management. All orders, newest first, with filters. The
// owner taps through to approve/reject. Pending orders are surfaced first with a
// count so nothing waits unseen.
// Tabs in the order work flows through them. "In process" = approved or
// packed (sale booked, not yet handed over); "Done" = delivered or picked up.
const STATUS_TABS = [
  ['pending', 'To approve', (s) => s === 'pending'],
  ['process', 'In process', (s) => s === 'approved' || s === 'packed'],
  ['done', 'Done', (s) => s === 'delivered' || s === 'picked_up'],
  ['rejected', 'Rejected', (s) => s === 'rejected'],
  ['all', 'All', () => true],
]

export default function OrderManagement() {
  const [orders, setOrders] = useState(null)
  const [err, setErr] = useState('')
  // Tab + filters live in the URL, so Back from an order lands on the same tab —
  // approving a run of orders never resets the list.
  const [params, setParams] = useSearchParams()
  const buyerType = params.get('buyer') || ''
  const itemKind = params.get('kind') || '' // '' | 'mto' | 'stock'
  const set = (k) => (v) => setParams((p) => {
    const n = new URLSearchParams(p)
    if (v) n.set(k, v)
    else n.delete(k)
    return n
  }, { replace: true })
  // Typing stays local: a URL-driven text box drops keystrokes (router updates
  // land a render late).
  const [q, setQ] = useState('')
  const setBuyerType = set('buyer'), setItemKind = set('kind'), setStatus = set('status')

  async function load() {
    setErr('')
    // Paged: PostgREST silently stops at 1000 rows (see fetchAll).
    const { data, error } = await fetchAll(() => supabase
      .from('orders')
      .select(
        'id, quantity, amount, status, buyer_type, source, created_at, order_group_id, ' +
          'item_no, item_name, ' +
          'item:items(name, photo_url, made_to_order), buyer:profiles!orders_buyer_id_fkey(full_name, phone)',
      )
      // Both origins land here now: shopfront orders wait for approval; counter
      // bills arrive already 'approved' (staff rang them up) and move straight
      // into the pack queue — 049.
      .order('created_at', { ascending: false }).order('id'))
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

  // Everything except the status tab — the tab counts reflect these filters.
  const matching = useMemo(() => {
    if (!orders) return []
    const needle = q.trim().toLowerCase()
    return orders.filter((o) => {
      if (buyerType && o.buyer_type !== buyerType) return false
      if (itemKind === 'mto' && !o.item?.made_to_order) return false
      if (itemKind === 'stock' && o.item?.made_to_order) return false
      if (needle) {
        const hay = `${o.item?.name || o.item_name || ''} ${o.buyer?.full_name || ''} ${o.buyer?.phone || ''}`.toLowerCase()
        if (!hay.includes(needle)) return false
      }
      return true
    })
  }, [orders, q, buyerType, itemKind])

  const counts = useMemo(
    () => Object.fromEntries(STATUS_TABS.map(([k, , test]) => [k, matching.filter((o) => test(o.status)).length])),
    [matching],
  )

  // No tab chosen yet → open on "To approve" when anything waits, else All.
  const status = params.get('status') || (orders && counts.pending === 0 ? 'all' : 'pending')
  const filtered = useMemo(() => {
    const test = (STATUS_TABS.find(([k]) => k === status) || STATUS_TABS[4])[2]
    return matching.filter((o) => test(o.status))
  }, [matching, status])

  // Lines of one shopfront cart share order_group_id — label them "1 of 3" so
  // a multi-item order is obvious in the list.
  const groupInfo = useMemo(() => {
    const byGroup = {}
    for (const o of orders || []) if (o.order_group_id) (byGroup[o.order_group_id] ||= []).push(o.id)
    const info = {}
    for (const ids of Object.values(byGroup)) {
      if (ids.length < 2) continue
      // Oldest-first numbering; the list itself is newest first.
      ;[...ids].reverse().forEach((id, i) => { info[id] = { n: i + 1, of: ids.length } })
    }
    return info
  }, [orders])

  return (
    <div className="space-y-5">
      {/* Status tabs — where the owner works from. */}
      <div role="tablist" aria-label="Order status" className="no-scrollbar -mx-4 flex gap-1 overflow-x-auto border-b border-line px-4 sm:mx-0 sm:px-0">
        {STATUS_TABS.map(([key, label]) => {
          const on = status === key
          return (
            <button
              key={key} type="button" role="tab" aria-selected={on}
              onClick={() => setStatus(key)}
              className={`-mb-px inline-flex h-11 shrink-0 items-center gap-2 border-b-2 px-3 text-sm font-medium transition-colors duration-150 ${
                on ? 'border-peacock text-ink' : 'border-transparent text-muted hover:text-ink'
              }`}
            >
              {label}
              {orders && key !== 'all' && counts[key] > 0 && (
                <span className={`fig rounded-full px-1.5 text-xs ${key === 'pending' ? 'bg-saffron text-white' : 'bg-paper-2 text-muted'}`}>
                  {counts[key]}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* Search + narrowing, one row */}
      <div className="flex flex-wrap gap-2">
        <div className="relative min-w-0 flex-1 basis-60">
          <label htmlFor="order-search" className="sr-only">Search orders</label>
          <IconSearch size={18} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            id="order-search" type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search buyer, phone or item…"
            className="h-11 w-full rounded-lg border border-line bg-card pl-9 pr-3 text-ink outline-none focus:border-peacock focus:ring-1 focus:ring-peacock"
          />
        </div>
        <select value={buyerType} onChange={(e) => setBuyerType(e.target.value)} aria-label="Buyer type"
                className="h-11 rounded-lg border border-line bg-card px-3 text-sm text-ink outline-none focus:border-peacock focus:ring-1 focus:ring-peacock">
          <option value="">All buyers</option>
          <option value="customer">Customers</option>
          <option value="dealer">Dealers</option>
        </select>
        <select value={itemKind} onChange={(e) => setItemKind(e.target.value)} aria-label="Item type"
                className="h-11 rounded-lg border border-line bg-card px-3 text-sm text-ink outline-none focus:border-peacock focus:ring-1 focus:ring-peacock">
          <option value="">All items</option>
          <option value="mto">Make to order</option>
          <option value="stock">Stock items</option>
        </select>
      </div>

      {err && <p className="rounded-lg bg-dues/10 px-4 py-3 text-sm text-dues">{err}</p>}

      {orders === null ? (
        <div className="grid place-items-center py-16 text-muted"><Spinner /></div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-16 text-center text-muted">
          <IconInbox size={36} stroke={1.3} aria-hidden />
          <p className="font-medium text-ink">
            {status === 'pending' ? 'Nothing to approve' : 'No orders here'}
          </p>
          <p className="text-sm">
            {q || buyerType || itemKind
              ? 'Try clearing the search or filters.'
              : status === 'pending' ? 'New shopfront orders appear here the moment they’re placed.' : 'Orders will show here as they move along.'}
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-card">
          {filtered.map((o) => (
            <li key={o.id}>
              <Link
                to={`/owner/orders/${o.id}`}
                className="flex items-center gap-3 p-3 transition-colors duration-150 hover:bg-paper-2 sm:gap-4"
              >
                <PhotoThumb url={o.item?.photo_url} />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 truncate font-medium text-ink">
                    <span className="truncate">{o.item?.name || o.item_name || 'Item'}</span>
                    {o.item?.made_to_order && <Badge tone="peacock">Make to order</Badge>}
                    {o.source === 'counter' && <Badge tone="saffron">Counter</Badge>}
                  </p>
                  <p className="truncate text-xs text-muted">
                    {o.buyer?.full_name || 'Buyer'}
                    <Badge tone={o.buyer_type === 'dealer' ? 'peacock' : 'muted'} className="ml-1.5">
                      {o.buyer_type}
                    </Badge>
                    {groupInfo[o.id] && (
                      <span className="ml-2 font-medium text-ink/80">{groupInfo[o.id].n} of {groupInfo[o.id].of} in order</span>
                    )}
                    <span className="ml-2">{dateTime(o.created_at)}</span>
                  </p>
                </div>
                <div className="text-right">
                  <p className="fig font-semibold">{money(o.amount)}</p>
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

