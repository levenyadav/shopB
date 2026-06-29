import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  IconArrowLeft, IconPhoto, IconCircleCheck, IconCircleX, IconAlertTriangle,
} from '@tabler/icons-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import { useShop } from '../../context/ShopContext'
import { money, qty, dateTime } from '../../lib/format'
import { lineProfit, round2 } from '../../lib/helpers'
import { Button, Textarea, OrderStatusBadge, Badge, Spinner } from '../../components/ui'

// SPEC §6.4 / §6.5 — owner approves or rejects. Approval INSERTS a sale row; the
// on_sale_insert trigger then drops stock, books the ledger, flips the order to
// 'approved' and opens a fulfilment record (Golden Rules #2, #3, #10 — the client
// never mutates stock/ledger directly). Owner picks the payment type here.
const PAYMENTS = [
  ['cash', 'Cash'], ['upi', 'UPI'], ['udhaar', 'Udhaar (credit)'],
]

export default function OrderDetail() {
  const { id } = useParams()
  const { profile } = useAuth()
  const { currency } = useShop()
  const [order, setOrder] = useState(null)
  const [err, setErr] = useState('')
  const [missing, setMissing] = useState(false)
  const [justApproved, setJustApproved] = useState(false)

  async function load() {
    setErr('')
    const { data, error } = await supabase
      .from('orders')
      .select(
        'id, shop_id, quantity, rate_at_order, amount, status, notes, rejection_reason, buyer_type, ' +
          'created_at, item:items(id, name, photo_url, location, purchase_rate, category_id, quantity), ' +
          'buyer:profiles!orders_buyer_id_fkey(id, full_name, phone, balance_due)',
      )
      .eq('id', id)
      .maybeSingle()
    if (error) setErr(error.message)
    else if (!data) setMissing(true)
    else setOrder(data)
  }
  useEffect(() => { load() }, [id])

  if (missing) return <Empty>Order not found. <Link to="/owner/orders" className="font-medium text-peacock hover:underline">Back to orders</Link>.</Empty>
  if (err && !order) return <Empty>{err}</Empty>
  if (!order) return <div className="grid place-items-center py-20 text-muted"><Spinner /></div>

  const item = order.item
  const profit = lineProfit(order.rate_at_order, item?.purchase_rate ?? 0, order.quantity)
  const available = Number(item?.quantity ?? 0)
  const shortBy = order.quantity - available
  const isPending = order.status === 'pending'

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <Link to="/owner/orders" className="inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-ink">
        <IconArrowLeft size={17} /> All orders
      </Link>

      {/* Order summary */}
      <div className="relative rounded-2xl border border-line bg-card p-5">
        {(order.status === 'approved' || justApproved) && (
          <span className="posted-stamp absolute right-5 top-4 rounded px-3 py-1 text-sm font-bold">
            POSTED
          </span>
        )}
        <div className="flex items-center gap-4">
          <Thumb url={item?.photo_url} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-lg font-semibold">{item?.name || 'Item'}</p>
            <p className="text-xs text-muted">Order placed {dateTime(order.created_at)}</p>
          </div>
          <OrderStatusBadge status={order.status} />
        </div>

        <dl className="mt-5 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          <Row label="Buyer" value={
            <>{order.buyer?.full_name || '—'}
              <Badge tone={order.buyer_type === 'dealer' ? 'peacock' : 'muted'} className="ml-1.5">{order.buyer_type}</Badge>
            </>} />
          <Row label="Phone" value={<span className="fig">{order.buyer?.phone || '—'}</span>} />
          <Row label="Rack / Location" value={item?.location || '—'} />
          <Row label="Quantity" value={<span className="fig">{qty(order.quantity)} pcs</span>} />
          <Row label={`${order.buyer_type === 'dealer' ? 'Dealer ' : ''}rate (each)`} value={<span className="fig">{money(order.rate_at_order).replace('₹', currency)}</span>} />
          <Row label="Amount" value={<span className="fig font-semibold">{money(order.amount).replace('₹', currency)}</span>} />
          {order.notes && <Row label="Buyer note" value={order.notes} full />}
        </dl>

        {/* Owner-only economics */}
        <div className="mt-4 flex flex-wrap items-center gap-4 rounded-xl bg-paper-2 px-4 py-3 text-sm">
          <span className="text-muted">Cost <span className="fig text-ink">{money(round2((item?.purchase_rate ?? 0) * order.quantity)).replace('₹', currency)}</span></span>
          <span className="text-muted">Profit <span className="fig font-semibold text-profit">{money(profit).replace('₹', currency)}</span></span>
          <span className="text-muted">Buyer udhaar now <span className="fig text-dues">{money(order.buyer?.balance_due).replace('₹', currency)}</span></span>
        </div>
      </div>

      {/* Actions */}
      {isPending ? (
        available < order.quantity ? (
          <div className="rounded-2xl border border-dues/30 bg-dues/10 p-5">
            <div className="flex items-center gap-2 text-dues">
              <IconAlertTriangle size={20} />
              <p className="font-semibold">Not enough stock to approve</p>
            </div>
            <p className="mt-1 text-sm text-ink/80">
              Only <span className="fig">{available}</span> in stock but the order is for <span className="fig">{order.quantity}</span>.
              Short by <span className="fig">{shortBy}</span>. Record a Purchase Entry first, then approve.
            </p>
            <div className="mt-3 flex gap-3">
              <Link to="/owner/purchase" className="rounded-lg bg-peacock px-4 py-2.5 text-sm font-semibold text-white hover:bg-peacock-700">
                New Purchase
              </Link>
              <RejectButtonInline order={order} onDone={load} />
            </div>
          </div>
        ) : (
          <ApprovePanel
            order={order} item={item} profit={profit} ownerId={profile.id}
            currency={currency}
            onApproved={() => { setJustApproved(true); load() }}
            onRejected={load}
          />
        )
      ) : order.status === 'rejected' ? (
        <div className="rounded-2xl border border-line bg-card p-5 text-sm text-muted">
          This order was rejected.{order.rejection_reason ? <> Reason: <span className="text-ink">{order.rejection_reason}</span></> : ' No stock or money changed.'}
        </div>
      ) : (
        <div className="rounded-2xl border border-profit/30 bg-profit/10 p-5 text-sm text-ink/80">
          <div className="flex items-center gap-2 text-profit">
            <IconCircleCheck size={20} />
            <p className="font-semibold">Approved — sale recorded</p>
          </div>
          <p className="mt-1">Stock has been adjusted and a fulfilment job opened for packing.</p>
        </div>
      )}

      {err && order && <p className="rounded-lg bg-dues/10 px-4 py-3 text-sm text-dues">{err}</p>}
    </div>
  )
}

function ApprovePanel({ order, item, profit, ownerId, currency, onApproved, onRejected }) {
  const [pay, setPay] = useState('cash')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [rejecting, setRejecting] = useState(false)

  async function approve() {
    setBusy(true); setErr('')
    // Insert the sale; the trigger does stock/ledger/fulfilment/order-status.
    const { error } = await supabase.from('sales').insert({
      shop_id: order.shop_id,
      order_id: order.id,
      item_id: item.id,
      category_id: item.category_id,
      buyer_id: order.buyer.id,
      buyer_type: order.buyer_type,
      quantity: order.quantity,
      rate_charged: order.rate_at_order,
      amount: order.amount,
      purchase_rate: item.purchase_rate,
      profit,
      payment_type: pay,
      approved_by: ownerId,
    })
    setBusy(false)
    if (error) { setErr(error.message); return }
    onApproved()
  }

  if (rejecting) return <RejectPanel order={order} onCancel={() => setRejecting(false)} onDone={onRejected} />

  return (
    <div className="space-y-4 rounded-2xl border border-line bg-card p-5">
      <p className="font-semibold">Approve this order</p>

      <div>
        <p className="mb-1.5 text-sm font-medium">How is the buyer paying?</p>
        <div className="grid grid-cols-3 gap-2">
          {PAYMENTS.map(([key, label]) => (
            <button
              key={key} type="button" onClick={() => setPay(key)}
              className={`rounded-lg border px-3 py-2.5 text-sm font-medium transition ${
                pay === key ? 'border-peacock bg-peacock/10 text-peacock' : 'border-line bg-card text-muted hover:text-ink'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {pay === 'udhaar' && (
          <p className="mt-2 text-xs text-saffron">
            Udhaar adds {money(order.amount).replace('₹', currency)} to the buyer’s running balance. Clear it later via Payment In.
          </p>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-line pt-3 text-sm">
        <span className="text-muted">Profit on this sale</span>
        <span className="fig font-semibold text-profit">{money(profit).replace('₹', currency)}</span>
      </div>

      {err && <p className="rounded-lg bg-dues/10 px-3 py-2 text-sm text-dues">{err}</p>}

      <div className="flex gap-3">
        <Button onClick={approve} disabled={busy} className="flex-1">
          {busy ? <><Spinner /> Approving…</> : <><IconCircleCheck size={18} /> Approve &amp; record sale</>}
        </Button>
        <Button variant="danger" onClick={() => setRejecting(true)} disabled={busy}>
          <IconCircleX size={18} /> Reject
        </Button>
      </div>
    </div>
  )
}

function RejectPanel({ order, onCancel, onDone }) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function reject() {
    setBusy(true); setErr('')
    const { error } = await supabase
      .from('orders')
      .update({ status: 'rejected', rejection_reason: reason.trim() || null })
      .eq('id', order.id)
    setBusy(false)
    if (error) { setErr(error.message); return }
    onDone()
  }

  return (
    <div className="space-y-4 rounded-2xl border border-dues/30 bg-card p-5">
      <p className="font-semibold">Reject this order</p>
      <Textarea
        label="Reason (optional — shown to the buyer)"
        rows={2} value={reason} onChange={(e) => setReason(e.target.value)}
        placeholder="e.g. item discontinued, minimum quantity not met…"
      />
      {err && <p className="rounded-lg bg-dues/10 px-3 py-2 text-sm text-dues">{err}</p>}
      <div className="flex gap-3">
        <Button variant="danger" onClick={reject} disabled={busy} className="flex-1">
          {busy ? <><Spinner /> Rejecting…</> : 'Confirm rejection'}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
      <p className="text-xs text-muted">Rejecting changes no stock and no money. The order simply closes.</p>
    </div>
  )
}

// Used when stock is short: lets the owner still reject without approving.
function RejectButtonInline({ order, onDone }) {
  const [open, setOpen] = useState(false)
  if (open) return <RejectPanel order={order} onCancel={() => setOpen(false)} onDone={onDone} />
  return (
    <Button variant="ghost" onClick={() => setOpen(true)}>Reject instead</Button>
  )
}

function Row({ label, value, full }) {
  return (
    <div className={full ? 'col-span-2 sm:col-span-3' : ''}>
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
