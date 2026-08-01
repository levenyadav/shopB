import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  IconArrowLeft, IconPhoto, IconCircleCheck, IconCircle, IconCircleX,
  IconEye, IconPrinter,
} from '@tabler/icons-react'
import { supabase } from '../../lib/supabase'
import { useShop } from '../../context/ShopContext'
import { money, qty, dateTime } from '../../lib/format'
import { round2, itemGstRate, gstOnTopByRate } from '../../lib/helpers'
import { buildInvoiceModel, viewInvoice, printInvoice } from '../../lib/invoiceTemplate'
import { Button, OrderStatusBadge, Spinner } from '../../components/ui'

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
  const { shop, currency } = useShop()
  const [order, setOrder] = useState(null)   // the representative (clicked) line
  const [lines, setLines] = useState([])     // all lines of the group
  const [invoices, setInvoices] = useState({}) // order_id -> customer_invoices row
  const [bills, setBills] = useState({})       // order_id -> customer_bills row
  const [err, setErr] = useState('')
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    let active = true
    async function load() {
      const { data, error } = await supabase
        .from('orders')
        .select(
          'id, item_id, quantity, rate_at_order, amount, status, notes, ' +
            'rejection_reason, created_at, updated_at, order_group_id, packed_by_name',
        )
        .eq('id', id)
        .maybeSingle()
      if (!active) return
      if (error) { setErr(error.message); return }
      if (!data) { setMissing(true); return }

      // A grouped order (cart) shows all its lines; a legacy order is a group of
      // one. RLS already scopes orders to this buyer, so the sibling query is safe.
      let rows = [data]
      if (data.order_group_id) {
        const { data: sibs } = await supabase
          .from('orders')
          .select('id, item_id, item_name, quantity, rate_at_order, amount, status, notes, rejection_reason, created_at, order_group_id, packed_by_name')
          .eq('order_group_id', data.order_group_id)
          .order('created_at')
        if (sibs?.length) rows = sibs
      }

      // Resolve item name/photo for every line from the column-safe view (Golden
      // Rule #4 — buyers never read the items table / purchase_rate).
      const itemIds = [...new Set(rows.map((r) => r.item_id))]
      const byId = {}
      if (itemIds.length) {
        const { data: items } = await supabase
          .from('shopfront_items').select('id, name, photo_url, gst_rate').in('id', itemIds)
        for (const it of items ?? []) byId[it.id] = it
      }
      const withItem = rows.map((r) => ({ ...r, item: byId[r.item_id] || null }))

      // Invoices for the lines that have a Sale (approved+). Buyer-safe view only.
      const billable = withItem.filter((r) => r.status !== 'pending' && r.status !== 'rejected').map((r) => r.id)
      const invMap = {}
      const billMap = {}
      if (billable.length) {
        const [{ data: invs }, { data: bls }] = await Promise.all([
          supabase.from('customer_invoices').select('*').in('order_id', billable),
          // Charge breakdown (023) — subtotal/discount/shipping/packing/other/grand
          // total — via the buyer-safe view, so the invoice foots to what's owed.
          supabase.from('customer_bills').select('*').in('order_id', billable),
        ])
        for (const iv of invs ?? []) invMap[iv.order_id] = iv
        for (const bl of bls ?? []) billMap[bl.order_id] = bl
      }

      if (active) {
        setOrder(data)
        setLines(withItem)
        setInvoices(invMap)
        setBills(billMap)
      }
    }
    load()
    return () => { active = false }
  }, [id])

  if (missing) return <Empty>Order not found. <Link to="/orders" className="font-medium text-peacock hover:underline">Back to my orders</Link>.</Empty>
  if (err) return <Empty>{err}</Empty>
  if (!order) return <div className="grid place-items-center py-20 text-muted"><Spinner /></div>

  // A rejected line is never charged (the notice below says so), so it stays out
  // of every figure here.
  const charged = lines.filter((l) => l.status !== 'rejected')
  const itemsTotal = round2(charged.reduce((s, l) => s + (Number(l.amount) || 0), 0))

  // Shipping / packing / other are set by the shop at approval (023) and only
  // exist from then on, so a pending order shows items and GST alone. Summing
  // the parts rather than grand_total keeps the maths right when some lines are
  // approved and some are not.
  const fees = charged.reduce((a, l) => {
    const b = bills[l.id]
    if (!b) return a
    return {
      discount: a.discount + Number(b.discount_amount || 0),
      shipping: a.shipping + Number(b.shipping_fee || 0),
      packing:  a.packing  + Number(b.packing_fee || 0),
      other:    a.other    + Number(b.other_charge || 0),
    }
  }, { discount: 0, shipping: 0, packing: 0, other: 0 })
  const hasFees = fees.discount > 0 || fees.shipping > 0 || fees.packing > 0 || fees.other > 0

  // GST is charged ON TOP of the rate (037), on the goods net of discount —
  // charges are pass-through and untaxed, matching the printed invoice. An
  // approved line uses the slab locked on its invoice and, where the shop has
  // already billed it, the tax the shop actually charged; a pending line is
  // estimated from the product's current slab.
  const taxedShare = itemsTotal > 0 ? Math.max(0, itemsTotal - fees.discount) / itemsTotal : 0
  const estimated = gstOnTopByRate(charged.map((l) => ({
    amount: round2((Number(l.amount) || 0) * taxedShare),
    rate: itemGstRate(invoices[l.id]?.item_gst_rate ?? l.item?.gst_rate, shop?.gst_rate),
  })))
  const billedTax = charged.reduce((a, l) => {
    const b = bills[l.id]
    if (!b) return a
    return { cgst: a.cgst + Number(b.cgst_amount || 0), sgst: a.sgst + Number(b.sgst_amount || 0) }
  }, { cgst: 0, sgst: 0 })
  const allBilled = charged.length > 0 && charged.every((l) => bills[l.id])
  const gst = allBilled
    ? (billedTax.cgst + billedTax.sgst > 0
        ? { ...billedTax, tax: round2(billedTax.cgst + billedTax.sgst), rate: estimated?.rate ?? null }
        : null)
    : estimated

  const totalAmount = round2(
    itemsTotal - fees.discount + fees.shipping + fees.packing + fees.other + (gst?.tax || 0),
  )

  const c = (n) => money(n).replace('₹', currency)
  const isGroup = lines.length > 1
  // Group status = least-progressed line, so the timeline reflects what's left.
  const groupStatus = lines.reduce(
    (acc, l) => (ORDER.indexOf(l.status) >= 0 && (acc == null || ORDER.indexOf(l.status) < ORDER.indexOf(acc)) ? l.status : acc),
    lines.every((l) => l.status === 'rejected') ? 'rejected' : null,
  ) || lines[0].status
  const rejected = groupStatus === 'rejected'

  const reachedIndex = ORDER.indexOf(groupStatus)
  // picked_up maps onto the final "Delivered / Picked up" step, so the active
  // step never runs past the last visible row.
  const currentStep = Math.min(reachedIndex, STEPS.length - 1)

  return (
    <div className="mx-auto max-w-xl space-y-5">
      <Link to="/orders" className="inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-ink">
        <IconArrowLeft size={17} /> My orders
      </Link>

      <div className="rounded-lg border border-line bg-card p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-lg font-semibold">{isGroup ? `Order · ${lines.length} items` : (lines[0].item?.name || lines[0].item_name || 'Item')}</p>
            <p className="text-xs text-muted">Placed {dateTime(order.created_at)}</p>
          </div>
          <OrderStatusBadge status={groupStatus} audience="buyer" />
        </div>

        {/* Line items */}
        <ul className="mt-4 divide-y divide-line">
          {lines.map((l) => {
            const inv = invoices[l.id]
            const lineGst = itemGstRate(inv?.item_gst_rate ?? l.item?.gst_rate, shop?.gst_rate)
            const model = inv && buildInvoiceModel({
              shop,
              buyer: {
                name: inv.bill_to_name, address: inv.bill_to_address, gstin: inv.bill_to_gstin,
                state_name: inv.bill_to_state_name, state_code: inv.bill_to_state_code, type: inv.buyer_type,
              },
              invoice: { invoice_no: inv.invoice_no, date: inv.created_at, notes: inv.invoice_notes },
              lines: [{
                name: inv.item_name, item_no: inv.item_no, hsn: inv.hsn_sac,
                gstRate: inv.item_gst_rate, qty: inv.quantity, rate: inv.rate_charged,
              }],
              bill: bills[l.id],
              gstRate: shop?.gst_rate,
            })
            return (
              <li key={l.id} className="flex items-start gap-3 py-3 first:pt-0">
                <Thumb url={l.item?.photo_url} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-ink">{l.item?.name || l.item_name || 'Item'}</p>
                  {/* Every number carries its label (SPEC §3) — a bare "200 × ₹18"
                      leaves the buyer to work out which figure is which. */}
                  <p className="text-xs text-muted">
                    Quantity <span className="fig text-ink">{qty(l.quantity)}</span>
                    {' · '}Rate <span className="fig text-ink">{c(l.rate_at_order)}</span> each
                    {lineGst > 0 && <>{' · '}GST <span className="fig text-ink">{lineGst}%</span> extra</>}
                  </p>
                  {isGroup && <p className="mt-1"><OrderStatusBadge status={l.status} audience="buyer" /></p>}
                  {l.notes && <p className="mt-0.5 text-xs text-muted">Note: {l.notes}</p>}
                  {model && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-3">
                      <span className="text-xs text-muted">Invoice <span className="fig text-ink">{inv.invoice_no}</span></span>
                      <button onClick={() => viewInvoice(model)} className="inline-flex items-center gap-1 text-xs font-medium text-peacock hover:underline">
                        <IconEye size={14} /> View
                      </button>
                      <button onClick={() => printInvoice(model)} className="inline-flex items-center gap-1 text-xs font-medium text-muted hover:text-ink">
                        <IconPrinter size={14} /> Download
                      </button>
                    </div>
                  )}
                  {l.status === 'rejected' && l.rejection_reason && (
                    <p className="mt-0.5 text-xs text-dues">Rejected: {l.rejection_reason}</p>
                  )}
                </div>
                <span className="fig shrink-0 font-semibold">{money(l.amount).replace('₹', currency)}</span>
              </li>
            )
          })}
        </ul>

        {/* Amount details — what makes up the total, so the buyer never has to
            ask why it differs from the item prices (SPEC §3: no dead ends). */}
        <dl className="mt-3 space-y-1.5 border-t border-line pt-3 text-sm">
          <Charge label={`Items (${charged.length} ${charged.length === 1 ? 'item' : 'items'})`} value={c(itemsTotal)} />
          {fees.discount > 0 && <Charge label="Discount" value={`− ${c(fees.discount)}`} good />}
          {fees.shipping > 0 && <Charge label="Shipping fee" value={c(fees.shipping)} />}
          {fees.packing > 0 && <Charge label="Packing & handling" value={c(fees.packing)} />}
          {fees.other > 0 && <Charge label="Other charges" value={c(fees.other)} />}
          {gst && (
            <>
              <Charge label={`CGST${gst.rate ? ` @ ${round2(gst.rate / 2)}%` : ''}`} value={c(gst.cgst)} />
              <Charge label={`SGST${gst.rate ? ` @ ${round2(gst.rate / 2)}%` : ''}`} value={c(gst.sgst)} />
            </>
          )}
        </dl>

        <div className="mt-3 flex items-center justify-between border-t border-line pt-3 text-sm">
          <span className="font-semibold">Total amount</span>
          <span className="fig text-lg font-bold">{c(totalAmount)}</span>
        </div>

        {gst && (
          <p className="mt-1 text-xs text-muted">
            GST <span className="fig">{c(gst.tax)}</span>
            {gst.rate ? <> at <span className="fig">{gst.rate}%</span></> : ' (across the rates above)'}
            {' '}is charged on top of the item prices.
            {!allBilled && ' The shop confirms the final figure when it accepts the order.'}
          </p>
        )}
        {!hasFees && groupStatus === 'pending' && (
          <p className="mt-1 text-xs text-muted">
            Any shipping or packing fee is added when the shop confirms this order.
          </p>
        )}
      </div>

      {/* Status */}
      {rejected ? (
        <div className="rounded-lg border border-dues/30 bg-dues/10 p-5">
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
        <div className="rounded-lg border border-line bg-card p-5">
          <p className="text-sm font-semibold">Progress</p>
          <p className="mb-4 mt-0.5 text-sm text-muted">{STATUS_NOTE[order.status] || ''}</p>
          {lines.find((l) => l.packed_by_name) && (
            <p className="-mt-3 mb-4 text-xs text-muted">
              Packed by <span className="font-medium text-ink">{lines.find((l) => l.packed_by_name).packed_by_name}</span>
            </p>
          )}
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

function Charge({ label, value, good }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className={`fig ${good ? 'text-profit' : 'text-ink'}`}>{value}</dd>
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
    <div className="h-14 w-14 shrink-0 overflow-hidden rounded-lg border border-line bg-paper-2">
      {url ? <img src={url} alt="" className="h-full w-full object-cover" />
           : <div className="grid h-full w-full place-items-center text-muted"><IconPhoto size={22} /></div>}
    </div>
  )
}

function Empty({ children }) {
  return <div className="mx-auto max-w-md rounded-lg border border-dashed border-line p-10 text-center text-muted">{children}</div>
}
