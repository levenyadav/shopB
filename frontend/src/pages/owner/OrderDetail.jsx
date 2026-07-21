import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  IconArrowLeft, IconPhoto, IconCircleCheck, IconCircleX, IconCircle, IconAlertTriangle,
  IconBrandWhatsapp, IconCopy, IconCheck, IconMessage2Question,
} from '@tabler/icons-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import { useShop } from '../../context/ShopContext'
import { money, qty, dateTime } from '../../lib/format'
import { lineProfit, round2, toE164India } from '../../lib/helpers'
import {
  Button, Textarea, OrderStatusBadge, InProcessBadge, IN_PROCESS_STATUSES, Badge, Spinner,
} from '../../components/ui'

// Owner-side fulfilment timeline (post-approval). orders.status advances
// approved → packed → delivered/picked_up via the fulfilment trigger, so it
// tracks reality live (Golden Rule #10 — the client only reads it here).
const OWNER_STEPS = [
  { key: 'approved',  label: 'Approved — sale recorded' },
  { key: 'packed',    label: 'Packed' },
  { key: 'delivered', label: 'Delivered / Picked up' },
]
const FLOW = ['approved', 'packed', 'delivered', 'picked_up']

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
  const { currency, shop } = useShop()
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
          'created_at, item_no, item_name, item:items(id, name, photo_url, location, purchase_rate, category_id, quantity, made_to_order, company_no, ' +
          'supplier:suppliers(id, name, contact_person, phone)), ' +
          'buyer:profiles!orders_buyer_id_fkey(id, full_name, phone, balance_due)',
      )
      .eq('id', id)
      .maybeSingle()
    if (error) setErr(error.message)
    else if (!data) setMissing(true)
    else setOrder(data)
  }
  useEffect(() => { load() }, [id])

  // Live status: once approved, staff packing/delivering updates this order's
  // row — reflect it here without a refresh (SPEC §5 Realtime).
  useEffect(() => {
    const channel = supabase
      .channel(`owner-order-${id}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'orders', filter: `id=eq.${id}` }, load)
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [id])

  if (missing) return <Empty>Order not found. <Link to="/owner/orders" className="font-medium text-peacock hover:underline">Back to orders</Link>.</Empty>
  if (err && !order) return <Empty>{err}</Empty>
  if (!order) return <div className="grid place-items-center py-20 text-muted"><Spinner /></div>

  const item = order.item
  const madeToOrder = item?.made_to_order === true
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
      <div className="relative rounded-lg border border-line bg-card p-5">
        {(order.status === 'approved' || justApproved) && (
          <span className="posted-stamp absolute right-5 top-4 rounded px-3 py-1 text-sm font-bold">
            POSTED
          </span>
        )}
        <div className="flex items-center gap-4">
          <Thumb url={item?.photo_url} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-lg font-semibold">{item?.name || order.item_name || 'Item'}</p>
            <p className="text-xs text-muted">Order placed {dateTime(order.created_at)}</p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <OrderStatusBadge status={order.status} />
            {IN_PROCESS_STATUSES.includes(order.status) && <InProcessBadge />}
          </div>
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

        {/* Owner-only economics. Cost comes from the item's purchase rate for both
            stock and made-to-order items (entered in Purchase Entry). */}
        <div className="mt-4 flex flex-wrap items-center gap-4 rounded-lg bg-paper-2 px-4 py-3 text-sm">
          <span className="text-muted">Cost <span className="fig text-ink">{money(round2((item?.purchase_rate ?? 0) * order.quantity)).replace('₹', currency)}</span></span>
          <span className="text-muted">Profit <span className="fig font-semibold text-profit">{money(profit).replace('₹', currency)}</span></span>
          <span className="text-muted">Buyer udhaar now <span className="fig text-dues">{money(order.buyer?.balance_due).replace('₹', currency)}</span></span>
        </div>
      </div>

      {/* Ask the supplier about this product (availability / lead time / rate)
          before approving — especially for made-to-order or short-stock items. */}
      {item?.supplier && (
        <SupplierInquiry item={item} order={order} shopName={shop?.name} />
      )}

      {/* Actions */}
      {isPending ? (
        (!madeToOrder && available < order.quantity) ? (
          <div className="rounded-lg border border-dues/30 bg-dues/10 p-5">
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
            currency={currency} madeToOrder={madeToOrder}
            onApproved={() => { setJustApproved(true); load() }}
            onRejected={load}
          />
        )
      ) : order.status === 'rejected' ? (
        <div className="rounded-lg border border-line bg-card p-5 text-sm text-muted">
          This order was rejected.{order.rejection_reason ? <> Reason: <span className="text-ink">{order.rejection_reason}</span></> : ' No stock or money changed.'}
        </div>
      ) : (
        <ApprovedTracker order={order} />
      )}

      {err && order && <p className="rounded-lg bg-dues/10 px-4 py-3 text-sm text-dues">{err}</p>}
    </div>
  )
}

// Post-approval: sale is booked, fulfilment underway. Live timeline driven by
// orders.status (kept current by the Realtime subscription above).
function ApprovedTracker({ order }) {
  const isDone = order.status === 'delivered' || order.status === 'picked_up'
  const reached = FLOW.indexOf(order.status)
  const currentStep = Math.min(reached, OWNER_STEPS.length - 1)

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-profit/30 bg-profit/10 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-profit">
            <IconCircleCheck size={20} />
            <p className="font-semibold">Approved — sale recorded</p>
          </div>
          {IN_PROCESS_STATUSES.includes(order.status) && <InProcessBadge />}
        </div>
        <p className="mt-1 text-sm text-ink/80">Stock has been adjusted and a fulfilment job opened. Track its progress live below.</p>
      </div>

      <div className="rounded-lg border border-line bg-card p-5">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold">Fulfilment status</p>
          <span className="inline-flex items-center gap-1.5 text-xs text-muted">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-profit" /> Updates live
          </span>
        </div>
        <ol className="mt-4 space-y-3">
          {OWNER_STEPS.map((step, i) => {
            const done = i <= currentStep
            const isCurrent = i === currentStep
            return (
              <li key={step.key} className="flex items-center gap-3">
                {done
                  ? <IconCircleCheck size={20} className="text-profit" />
                  : <IconCircle size={20} className="text-line" />}
                <span className={isCurrent ? 'text-sm font-semibold text-ink' : done ? 'text-sm text-ink/70' : 'text-sm text-muted'}>
                  {step.label}
                </span>
                {isCurrent && !isDone && (
                  <span className="rounded-full bg-peacock/10 px-2 py-0.5 text-[11px] font-semibold text-peacock">Now</span>
                )}
              </li>
            )
          })}
        </ol>
        <Link to="/owner/fulfilment" className="mt-4 inline-block text-sm font-semibold text-peacock hover:underline">
          {isDone ? 'View in Fulfilment →' : 'Go to Fulfilment to pack & print the supply slip →'}
        </Link>
      </div>
    </div>
  )
}

// Evaluate one charge rule against this order; returns the fee (>=0) or null if
// the rule doesn't apply. Mirrors the intent baked into charge_rules (migration
// 023): buyer-type gate + a value/quantity condition; % fees are of order value.
function evalRule(rule, { buyerType, orderValue, quantity }) {
  if (rule.is_active === false) return null
  if (rule.applies_to !== 'all' && rule.applies_to !== buyerType) return null
  const val = rule.basis === 'quantity' ? Number(quantity) : Number(orderValue)
  const t = Number(rule.threshold)
  const hi = rule.threshold_hi == null ? null : Number(rule.threshold_hi)
  let ok = false
  if (rule.operator === 'lt') ok = val < t
  else if (rule.operator === 'lte') ok = val <= t
  else if (rule.operator === 'gte') ok = val >= t
  else if (rule.operator === 'gt') ok = val > t
  else if (rule.operator === 'between') ok = hi != null && val >= t && val <= hi
  if (!ok) return null
  return rule.is_percent ? round2((Number(orderValue) * Number(rule.fee)) / 100) : Number(rule.fee)
}

// Highest applicable fee for a charge type (a free-shipping rule sets fee 0, so a
// qualifying free-shipping rule still wins only if it's the highest — see Settings).
function suggestFee(rules, type, ctx) {
  let best = null
  for (const r of rules) {
    if (r.charge_type !== type) continue
    const f = evalRule(r, ctx)
    if (f != null && (best == null || f > best)) best = f
  }
  return best
}

// Parse a money input box to a non-negative number (blank -> 0).
const num = (v) => Math.max(0, Number(v || 0))

function ApprovePanel({ order, item, profit, ownerId, currency, madeToOrder, onApproved, onRejected }) {
  const [pay, setPay] = useState('cash')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [rejecting, setRejecting] = useState(false)

  // Finalize-bill charges (migration 023). Per-line price is NEVER edited here
  // (Golden Rule #5) — these sit on TOP of the product subtotal the buyer saw.
  const [discount, setDiscount] = useState('')
  const [shipping, setShipping] = useState('')
  const [packing, setPacking] = useState('')
  const [other, setOther] = useState('')
  const [notes, setNotes] = useState('')
  const [suggested, setSuggested] = useState(false)

  const cf = (n) => money(n).replace('₹', currency)
  // Cost is the item's known purchase rate for both stock and made-to-order items
  // (set in Purchase Entry / Inventory). A made-to-order item with no cost set is
  // the only blocker — the RPC rejects it, so guard the button here too.
  const costNum = Number(item.purchase_rate ?? 0)
  const listProfit = profit
  const costMissing = madeToOrder && !(costNum > 0)

  const subtotal = Number(order.amount)
  const discountNum = Math.min(num(discount), subtotal)
  const netCharges = round2(num(shipping) + num(packing) + num(other) - discountNum)
  const grandTotal = round2(subtotal + netCharges)
  const effProfit = round2(listProfit - discountNum)   // discount is a real margin loss

  // Auto-suggest shipping / packing from the owner's charge_rules (Settings).
  useEffect(() => {
    let alive = true
    async function loadRules() {
      const { data } = await supabase
        .from('charge_rules')
        .select('charge_type, applies_to, basis, operator, threshold, threshold_hi, fee, is_percent, is_active')
        .eq('shop_id', order.shop_id)
      if (!alive || !data?.length) return
      const ctx = { buyerType: order.buyer_type, orderValue: subtotal, quantity: order.quantity }
      const sShip = suggestFee(data, 'shipping', ctx)
      const sPack = suggestFee(data, 'packing', ctx)
      if (sShip != null) setShipping(String(sShip))
      if (sPack != null) setPacking(String(sPack))
      if (sShip != null || sPack != null) setSuggested(true)
    }
    loadRules()
    return () => { alive = false }
  }, [order.shop_id, order.buyer_type, order.quantity, subtotal])

  async function approve() {
    setBusy(true); setErr('')
    // One RPC (migration 023) books the sale GROSS + the net charges/discount
    // atomically: stock, udhaar, ledger, fulfilment, order-status and the bill.
    const { error } = await supabase.rpc('approve_order', {
      p_order_id: order.id,
      p_payment_type: pay,
      p_discount: discountNum,
      p_shipping: num(shipping),
      p_packing: num(packing),
      p_other: num(other),
      p_notes: notes.trim() || null,
    })
    setBusy(false)
    if (error) { setErr(error.message); return }
    onApproved()
  }

  if (rejecting) return <RejectPanel order={order} onCancel={() => setRejecting(false)} onDone={onRejected} />

  return (
    <div className="space-y-4 rounded-lg border border-line bg-card p-5">
      <p className="font-semibold">Finalize bill &amp; approve</p>

      {madeToOrder && (
        <div className="flex items-start gap-2 rounded-lg bg-peacock/5 px-4 py-2.5 text-sm">
          <span className="mt-0.5 shrink-0 rounded bg-peacock/10 px-1.5 py-0.5 text-[11px] font-semibold text-peacock">Make to order</span>
          {costMissing ? (
            <span className="text-dues">
              No purchase rate is set for this item. Set its cost in Inventory before approving so profit is accurate.
            </span>
          ) : (
            <span className="text-muted">
              Cost <span className="fig text-ink">{cf(costNum)}</span> each — taken from the item’s purchase rate.
            </span>
          )}
        </div>
      )}

      {/* Charges — added on top of the price the buyer already saw. */}
      <div className="space-y-3 rounded-lg border border-line bg-paper-2 p-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold">Charges &amp; discount</p>
          {suggested && (
            <span className="rounded-full bg-peacock/10 px-2 py-0.5 text-[11px] font-semibold text-peacock">
              Auto-filled from rules
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <ChargeInput label="Discount" value={discount} onChange={setDiscount} currency={currency} tone="dues" />
          <ChargeInput label="Shipping" value={shipping} onChange={setShipping} currency={currency} />
          <ChargeInput label="Packing" value={packing} onChange={setPacking} currency={currency} />
          <ChargeInput label="Other charge" value={other} onChange={setOther} currency={currency} />
        </div>
        <input
          value={notes} onChange={(e) => setNotes(e.target.value)}
          placeholder="Bill note (optional — prints on the invoice)"
          className="w-full rounded-lg border border-line bg-card px-3 py-2 text-sm outline-none focus:border-peacock"
        />
        <p className="text-[11px] text-muted">
          Prices already include GST (tax-inclusive) — nothing is added for tax. Shipping, packing &amp; other are
          pass-through (no profit); a discount reduces your profit.
        </p>
      </div>

      {/* Live bill breakdown */}
      <dl className="space-y-1.5 rounded-lg bg-paper-2 px-4 py-3 text-sm">
        <BillRow label="Subtotal" value={cf(subtotal)} />
        {discountNum > 0 && <BillRow label="Discount" value={'− ' + cf(discountNum)} tone="dues" />}
        {num(shipping) > 0 && <BillRow label="Shipping" value={'+ ' + cf(num(shipping))} />}
        {num(packing) > 0 && <BillRow label="Packing" value={'+ ' + cf(num(packing))} />}
        {num(other) > 0 && <BillRow label="Other" value={'+ ' + cf(num(other))} />}
        <div className="flex items-center justify-between border-t border-line pt-1.5 font-semibold">
          <span>Grand total</span>
          <span className="fig">{cf(grandTotal)}</span>
        </div>
      </dl>

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
            Udhaar adds {cf(grandTotal)} to the buyer’s running balance. Clear it later via Payment In.
          </p>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-line pt-3 text-sm">
        <span className="text-muted">Profit on this sale</span>
        <span className="fig font-semibold text-profit">
          {costMissing ? '—' : cf(effProfit)}
        </span>
      </div>

      {err && <p className="rounded-lg bg-dues/10 px-3 py-2 text-sm text-dues">{err}</p>}

      <div className="flex gap-3">
        <Button onClick={approve} disabled={busy || costMissing} className="flex-1">
          {busy ? <><Spinner /> Approving…</> : <><IconCircleCheck size={18} /> Approve &amp; record sale</>}
        </Button>
        <Button variant="danger" onClick={() => setRejecting(true)} disabled={busy}>
          <IconCircleX size={18} /> Reject
        </Button>
      </div>
    </div>
  )
}

function ChargeInput({ label, value, onChange, currency, tone }) {
  return (
    <label className="block">
      <span className={`mb-1 block text-xs font-medium ${tone === 'dues' ? 'text-dues' : 'text-muted'}`}>{label}</span>
      <div className="flex items-center rounded-lg border border-line bg-card focus-within:border-peacock">
        <span className="pl-2.5 text-xs text-muted">{currency}</span>
        <input
          type="number" min="0" step="0.01" inputMode="decimal"
          value={value} onChange={(e) => onChange(e.target.value)}
          placeholder="0"
          className="w-full bg-transparent px-2 py-2 text-sm outline-none"
        />
      </div>
    </label>
  )
}

function BillRow({ label, value, tone }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted">{label}</span>
      <span className={`fig ${tone === 'dues' ? 'text-dues' : 'text-ink'}`}>{value}</span>
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
    <div className="space-y-4 rounded-lg border border-dues/30 bg-card p-5">
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

// Build the default inquiry message the owner sends the supplier. Editable
// before sharing, so this is only a starting point (plain text, WhatsApp-safe).
function defaultInquiry({ item, order, supplier, shopName }) {
  const who = supplier?.contact_person || supplier?.name
  const hello = who ? `Hello ${who},` : 'Hello,'
  // The company/manufacturer's own design number (items.company_no) — that is
  // what the supplier can look up. Our internal item_no (SHOP-0001) means
  // nothing to them, so when no company_no is saved we quote the product name
  // instead rather than sending a code they cannot match.
  const code = item?.company_no?.trim()
  const productLine = code
    ? `Company Number (Product Code): ${code}`
    : `Product: ${item?.name || order.item_name || '—'}`
  return [
    hello,
    '',
    'We have received a customer order and would like to place the following requirement.',
    '',
    productLine,
    `Order Quantity: ${qty(order.quantity)} pcs`,
    '',
    'Kindly confirm the availability and expected dispatch date.',
    '',
    'Regards,',
    shopName || 'Khattri Card Pratham',
  ].join('\n')
}

// Owner-only helper on the approve screen: draft an inquiry and fire it to the
// item's supplier over WhatsApp. Reuses the wa.me deep-link pattern (Parties) and
// toE164India for the number. The message is editable so the owner can refine it.
function SupplierInquiry({ item, order, shopName }) {
  const supplier = item.supplier
  const e164 = toE164India(supplier?.phone)
  const [open, setOpen] = useState(false)
  const [msg, setMsg] = useState(() => defaultInquiry({ item, order, supplier, shopName }))
  const [copied, setCopied] = useState('')

  const waUrl = e164 ? `https://wa.me/${e164.replace('+', '')}?text=${encodeURIComponent(msg)}` : null

  async function copy(text, which) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(which)
      setTimeout(() => setCopied(''), 1600)
    } catch { /* clipboard unavailable — the WhatsApp button still works */ }
  }

  return (
    <div className="rounded-lg border border-line bg-card">
      <button
        type="button" onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-5 py-4 text-left"
      >
        <IconMessage2Question size={22} className="shrink-0 text-peacock" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-ink">Ask supplier about this product</p>
          <p className="truncate text-xs text-muted">
            {supplier?.name || 'Supplier'}
            {supplier?.phone && <span className="fig"> · {supplier.phone}</span>}
          </p>
        </div>
        <span className="shrink-0 text-xs font-medium text-peacock">{open ? 'Hide' : 'Draft message'}</span>
      </button>

      {open && (
        <div className="space-y-3 border-t border-line px-5 py-4">
          <Textarea
            label="Inquiry message (edit before sending)"
            rows={8} value={msg} onChange={(e) => setMsg(e.target.value)}
          />

          {!e164 && (
            <p className="flex items-center gap-1.5 rounded-lg bg-saffron/10 px-3 py-2 text-xs text-saffron">
              <IconAlertTriangle size={15} className="shrink-0" />
              No valid WhatsApp number saved for this supplier. Copy the message and send it manually, or add a number in Parties.
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <a
              href={waUrl || undefined}
              target="_blank" rel="noopener noreferrer"
              aria-disabled={!waUrl}
              onClick={(e) => { if (!waUrl) e.preventDefault() }}
              className={`inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition ${
                waUrl
                  ? 'bg-[#25D366] text-white hover:brightness-95'
                  : 'cursor-not-allowed bg-line/40 text-muted'
              }`}
            >
              <IconBrandWhatsapp size={18} /> Share on WhatsApp
            </a>
            {waUrl && (
              <button
                type="button" onClick={() => copy(waUrl, 'link')}
                className="inline-flex items-center gap-2 rounded-lg border border-line px-4 py-2.5 text-sm font-medium text-ink transition hover:border-ink/20"
              >
                {copied === 'link' ? <><IconCheck size={16} className="text-profit" /> Link copied</> : <><IconCopy size={16} /> Copy WhatsApp link</>}
              </button>
            )}
            <button
              type="button" onClick={() => copy(msg, 'text')}
              className="inline-flex items-center gap-2 rounded-lg border border-line px-4 py-2.5 text-sm font-medium text-ink transition hover:border-ink/20"
            >
              {copied === 'text' ? <><IconCheck size={16} className="text-profit" /> Copied</> : <><IconCopy size={16} /> Copy message</>}
            </button>
          </div>
        </div>
      )}
    </div>
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
    <div className="h-14 w-14 shrink-0 overflow-hidden rounded-lg border border-line bg-paper-2">
      {url ? <img src={url} alt="" className="h-full w-full object-cover" />
           : <div className="grid h-full w-full place-items-center text-muted"><IconPhoto size={22} /></div>}
    </div>
  )
}

function Empty({ children }) {
  return <div className="mx-auto max-w-md rounded-lg border border-dashed border-line p-10 text-center text-muted">{children}</div>
}
