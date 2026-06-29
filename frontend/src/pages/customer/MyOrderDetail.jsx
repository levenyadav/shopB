import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  IconArrowLeft, IconPhoto, IconCircleCheck, IconCircle, IconCircleX,
} from '@tabler/icons-react'
import { supabase } from '../../lib/supabase'
import { useShop } from '../../context/ShopContext'
import { money, qty, dateTime } from '../../lib/format'
import { OrderStatusBadge, Spinner } from '../../components/ui'

// SPEC §10.2 — a buyer's view of one order: what they bought, the locked rate,
// and how far it's progressed. Read-only; status is driven by the owner/staff.
const STEPS = [
  { key: 'pending',   label: 'Order placed' },
  { key: 'approved',  label: 'Confirmed by shop' },
  { key: 'packed',    label: 'Packed' },
  { key: 'delivered', label: 'Delivered / Picked up' },
]
const ORDER = ['pending', 'approved', 'packed', 'delivered', 'picked_up']

// One plain-language line telling the buyer what's happening right now, so an
// "approved" order clearly reads as being prepared — not a dead end (SPEC §3).
const STATUS_NOTE = {
  pending:   'Waiting for the shop to confirm your order.',
  approved:  'Confirmed — the shop is preparing your order.',
  packed:    'Packed and ready — it will be delivered or kept for pickup.',
  delivered: 'Delivered. Thank you!',
  picked_up: 'Picked up. Thank you!',
}

export default function MyOrderDetail() {
  const { id } = useParams()
  const { currency } = useShop()
  const [order, setOrder] = useState(null)
  const [err, setErr] = useState('')
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    let active = true
    async function load() {
      const { data, error } = await supabase
        .from('orders')
        .select(
          'id, item_id, quantity, rate_at_order, amount, status, notes, ' +
            'rejection_reason, created_at, updated_at',
        )
        .eq('id', id)
        .maybeSingle()
      if (!active) return
      if (error) { setErr(error.message); return }
      if (!data) { setMissing(true); return }
      // Resolve item name/photo from the column-safe view (Golden Rule #4).
      const { data: item } = await supabase
        .from('shopfront_items')
        .select('name, photo_url')
        .eq('id', data.item_id)
        .maybeSingle()
      if (active) setOrder({ ...data, item: item || null })
    }
    load()
    return () => { active = false }
  }, [id])

  if (missing) return <Empty>Order not found. <Link to="/orders" className="font-medium text-peacock hover:underline">Back to my orders</Link>.</Empty>
  if (err) return <Empty>{err}</Empty>
  if (!order) return <div className="grid place-items-center py-20 text-muted"><Spinner /></div>

  const rejected = order.status === 'rejected'
  const reachedIndex = ORDER.indexOf(order.status)
  // picked_up maps onto the final "Delivered / Picked up" step, so the active
  // step never runs past the last visible row.
  const currentStep = Math.min(reachedIndex, STEPS.length - 1)

  return (
    <div className="mx-auto max-w-xl space-y-5">
      <Link to="/orders" className="inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-ink">
        <IconArrowLeft size={17} /> My orders
      </Link>

      <div className="rounded-2xl border border-line bg-card p-5">
        <div className="flex items-center gap-4">
          <Thumb url={order.item?.photo_url} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-lg font-semibold">{order.item?.name || 'Item'}</p>
            <p className="text-xs text-muted">Placed {dateTime(order.created_at)}</p>
          </div>
          <OrderStatusBadge status={order.status} audience="buyer" />
        </div>

        <dl className="mt-5 grid grid-cols-2 gap-3 text-sm">
          <Row label="Quantity" value={<span className="fig">{qty(order.quantity)} pcs</span>} />
          <Row label="Rate (each)" value={<span className="fig">{money(order.rate_at_order).replace('₹', currency)}</span>} />
          <Row label="Total amount" value={<span className="fig font-semibold">{money(order.amount).replace('₹', currency)}</span>} />
          {order.notes && <Row label="Your note" value={order.notes} full />}
        </dl>
      </div>

      {/* Status */}
      {rejected ? (
        <div className="rounded-2xl border border-dues/30 bg-dues/10 p-5">
          <div className="flex items-center gap-2 text-dues">
            <IconCircleX size={20} />
            <p className="font-semibold">Order not accepted</p>
          </div>
          <p className="mt-1 text-sm text-ink/80">
            {order.rejection_reason
              ? `Reason: ${order.rejection_reason}`
              : 'The shop could not accept this order. Nothing was charged.'}
          </p>
        </div>
      ) : (
        <div className="rounded-2xl border border-line bg-card p-5">
          <p className="text-sm font-semibold">Progress</p>
          <p className="mb-4 mt-0.5 text-sm text-muted">{STATUS_NOTE[order.status] || ''}</p>
          <ol className="space-y-3">
            {STEPS.map((step, i) => {
              const done = i <= currentStep        // reached or passed this step
              const isCurrent = i === currentStep  // where the order is right now
              return (
                <li key={step.key} className="flex items-center gap-3">
                  {done
                    ? <IconCircleCheck size={20} className="text-profit" />
                    : <IconCircle size={20} className="text-line" />}
                  <span className={isCurrent ? 'font-semibold text-ink' : done ? 'text-ink/70' : 'text-muted'}>
                    {step.label}
                  </span>
                  {isCurrent && (
                    <span className="rounded-full bg-peacock/10 px-2 py-0.5 text-[11px] font-semibold text-peacock">
                      Now
                    </span>
                  )}
                </li>
              )
            })}
          </ol>
        </div>
      )}
    </div>
  )
}

function Row({ label, value, full }) {
  return (
    <div className={full ? 'col-span-2' : ''}>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-ink">{value}</dd>
    </div>
  )
}

function Thumb({ url }) {
  return (
    <div className="h-14 w-14 shrink-0 overflow-hidden rounded-xl border border-line bg-paper-2">
      {url ? <img src={url} alt="" className="h-full w-full object-cover" />
           : <div className="grid h-full w-full place-items-center text-muted"><IconPhoto size={22} /></div>}
    </div>
  )
}

function Empty({ children }) {
  return <div className="mx-auto max-w-md rounded-2xl border border-dashed border-line p-10 text-center text-muted">{children}</div>
}
