import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  IconArrowLeft, IconPhoto, IconPrinter, IconMapPin, IconReceipt2,
  IconShare, IconEye, IconPencil, IconDeviceFloppy, IconX,
} from '@tabler/icons-react'
import { supabase } from '../../lib/supabase'
import { useShop } from '../../context/ShopContext'
import { money, qty, dateTime } from '../../lib/format'
import { round2 } from '../../lib/helpers'
import { buildSlipPdf, sharePdf } from '../../lib/pdf'
import { buildInvoiceModel, viewInvoice, printInvoice } from '../../lib/invoiceTemplate'
import { Button, Badge, Spinner } from '../../components/ui'
import SupplySlip from '../../components/SupplySlip'
import { PAYMENT_META } from './Sales'

// SPEC §6.5 / §13.1 / §15 — one sale, with the owner-only economics (cost,
// profit) plus the two buyer-facing documents: the internal Order Supply Slip
// (reprintable) and the customer Tax Invoice. The sale itself is the immutable
// record written at approval (rate locked, Golden Rule #5); only the invoice's
// billing/presentation fields (Bill-To override, notes) are editable, and those
// live on the separate `invoices` row — the locked sale is never touched.
export default function SaleDetail() {
  const { id } = useParams()
  const { shop, currency } = useShop()
  const [sale, setSale] = useState(null)
  const [invoice, setInvoice] = useState(null)
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState(null)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const [missing, setMissing] = useState(false)

  async function loadInvoice(saleRow) {
    // Shopfront sale → invoice links by sale_id; counter line → by bill_id.
    const filter = saleRow.bill_id
      ? `sale_id.eq.${saleRow.id},bill_id.eq.${saleRow.bill_id}`
      : `sale_id.eq.${saleRow.id}`
    const { data } = await supabase
      .from('invoices')
      .select('id, invoice_no, bill_to_name, bill_to_address, bill_to_gstin, ' +
        'bill_to_state_name, bill_to_state_code, notes')
      .or(filter)
      .maybeSingle()
    setInvoice(data || null)
  }

  async function load() {
    setErr('')
    const { data, error } = await supabase
      .from('sales')
      .select(
        'id, order_id, bill_id, quantity, rate_charged, amount, purchase_rate, profit, payment_type, buyer_type, created_at, ' +
          'item:items(name, item_no, photo_url, location, hsn_sac), ' +
          'buyer:profiles!sales_buyer_id_fkey(full_name, phone, balance_due, gstin, address, state_name, state_code), ' +
          'category:categories(name), ' +
          'order:orders!sales_order_id_fkey(notes, created_at)',
      )
      .eq('id', id)
      .maybeSingle()
    if (error) setErr(error.message)
    else if (!data) setMissing(true)
    else { setSale(data); loadInvoice(data) }
  }
  useEffect(() => { load() }, [id])

  if (missing) return <Empty>Sale not found. <Link to="/owner/sales" className="font-medium text-peacock hover:underline">Back to sales</Link>.</Empty>
  if (err && !sale) return <Empty>{err}</Empty>
  if (!sale) return <div className="grid place-items-center py-20 text-muted"><Spinner /></div>

  const item = sale.item
  const pay = PAYMENT_META[sale.payment_type] || { label: sale.payment_type, tone: 'muted' }
  const cost = round2(Number(sale.purchase_rate || 0) * Number(sale.quantity || 0))

  // Reshape the sale into the shape SupplySlip expects (it was built for the
  // fulfilment_queue view). Buyer-facing figures only — never cost/profit.
  const slip = {
    order_id: sale.order_id,
    ordered_at: sale.order?.created_at || sale.created_at,
    buyer_name: sale.buyer?.full_name,
    buyer_type: sale.buyer_type,
    buyer_phone: sale.buyer?.phone,
    item_name: item?.name,
    item_no: item?.item_no,
    location: item?.location,
    quantity: sale.quantity,
    rate_at_order: sale.rate_charged,
    amount: sale.amount,
    payment_type: sale.payment_type,
    notes: sale.order?.notes,
  }

  // Customer Tax Invoice (Golden Rule #4: buyer-facing figures only). Bill-To
  // falls back to the buyer's profile when not overridden on the invoice.
  const billTo = {
    name: invoice?.bill_to_name || sale.buyer?.full_name,
    address: invoice?.bill_to_address || sale.buyer?.address,
    gstin: invoice?.bill_to_gstin || sale.buyer?.gstin,
    state_name: invoice?.bill_to_state_name || sale.buyer?.state_name,
    state_code: invoice?.bill_to_state_code || sale.buyer?.state_code,
    type: sale.buyer_type,
  }
  const invoiceModel = buildInvoiceModel({
    shop,
    buyer: billTo,
    invoice: { invoice_no: invoice?.invoice_no, date: sale.created_at, notes: invoice?.notes },
    lines: [{ name: item?.name, item_no: item?.item_no, hsn: item?.hsn_sac, qty: sale.quantity, rate: sale.rate_charged }],
    gstRate: shop?.gst_rate,
  })

  const ref = sale.order_id?.slice(0, 8).toUpperCase()
  const slipFile = `supply-slip-${ref}.pdf`

  function startEdit() {
    setForm({
      bill_to_name: invoice?.bill_to_name || '',
      bill_to_address: invoice?.bill_to_address || '',
      bill_to_gstin: invoice?.bill_to_gstin || '',
      bill_to_state_name: invoice?.bill_to_state_name || '',
      bill_to_state_code: invoice?.bill_to_state_code || '',
      notes: invoice?.notes || '',
    })
    setEditing(true)
  }

  async function saveInvoice() {
    if (!invoice?.id) return
    setSaving(true); setErr('')
    const patch = Object.fromEntries(
      Object.entries(form).map(([k, v]) => [k, v.trim() ? v.trim() : null]),
    )
    const { error } = await supabase.from('invoices').update(patch).eq('id', invoice.id)
    setSaving(false)
    if (error) { setErr(error.message); return }
    setEditing(false)
    loadInvoice(sale)
  }

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <Link to="/owner/sales" className="no-print inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-ink">
        <IconArrowLeft size={17} /> All sales
      </Link>

      {/* Sale summary */}
      <div className="relative rounded-lg border border-line bg-card p-5">
        <span className="posted-stamp absolute right-5 top-4 rounded px-3 py-1 text-sm font-bold">SOLD</span>
        <div className="flex items-center gap-4">
          <Thumb url={item?.photo_url} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-lg font-semibold">{item?.name || 'Item'}</p>
            <p className="text-xs text-muted">
              Sold {dateTime(sale.created_at)}
              {invoice?.invoice_no && <> · <span className="fig">{invoice.invoice_no}</span></>}
            </p>
          </div>
        </div>

        <dl className="mt-5 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          <Row label="Buyer" value={
            <>{sale.buyer?.full_name || '—'}
              <Badge tone={sale.buyer_type === 'dealer' ? 'peacock' : 'muted'} className="ml-1.5">{sale.buyer_type}</Badge>
            </>} />
          <Row label="Phone" value={<span className="fig">{sale.buyer?.phone || '—'}</span>} />
          <Row label="Category" value={sale.category?.name || '—'} />
          <Row label="Item No" value={<span className="fig">{item?.item_no || '—'}</span>} />
          <Row label="Rack / Location" value={<span className="inline-flex items-center gap-1">{item?.location ? <><IconMapPin size={15} /> {item.location}</> : '—'}</span>} />
          <Row label="Payment" value={<Badge tone={pay.tone}>{pay.label}</Badge>} />
          <Row label="Quantity" value={<span className="fig">{qty(sale.quantity)} pcs</span>} />
          <Row label={`${sale.buyer_type === 'dealer' ? 'Dealer ' : ''}rate (each)`} value={<span className="fig">{money(sale.rate_charged).replace('₹', currency)}</span>} />
          <Row label="Amount" value={<span className="fig font-semibold">{money(sale.amount).replace('₹', currency)}</span>} />
        </dl>

        {/* Owner-only economics (Golden Rules #3, #4 — never on slip or invoice) */}
        <div className="mt-4 flex flex-wrap items-center gap-4 rounded-lg bg-paper-2 px-4 py-3 text-sm">
          <span className="text-muted">Cost <span className="fig text-ink">{money(cost).replace('₹', currency)}</span></span>
          <span className="text-muted">Profit <span className="fig font-semibold text-profit">{money(sale.profit).replace('₹', currency)}</span></span>
          {sale.payment_type === 'udhaar' && (
            <span className="text-muted">Buyer udhaar now <span className="fig text-dues">{money(sale.buyer?.balance_due).replace('₹', currency)}</span></span>
          )}
        </div>
      </div>

      {/* Invoice actions */}
      <div className="no-print flex flex-wrap items-center gap-3">
        <Button onClick={() => viewInvoice(invoiceModel)}>
          <IconEye size={18} /> View invoice
        </Button>
        <Button variant="ghost" onClick={() => printInvoice(invoiceModel)}>
          <IconPrinter size={18} /> Print / Save PDF
        </Button>
        <Button variant="ghost" onClick={startEdit}>
          <IconPencil size={18} /> Edit billing
        </Button>
        <span className="mx-1 h-5 w-px bg-line" />
        <Button variant="ghost" onClick={() => sharePdf(buildSlipPdf(slip, shop), slipFile, `Supply slip #${ref}`)}>
          <IconShare size={18} /> Share slip
        </Button>
        <Button variant="ghost" onClick={() => window.print()}>
          <IconReceipt2 size={18} /> Reprint slip
        </Button>
      </div>

      {/* Edit billing — only the invoice's presentational fields (Bill-To +
          notes). The sale's amount/qty/rate stay locked (Golden Rule #5/#6). */}
      {editing && (
        <div className="no-print rounded-lg border border-line bg-card p-5">
          <div className="mb-3 flex items-center justify-between">
            <p className="font-semibold">Edit invoice billing</p>
            <button onClick={() => setEditing(false)} className="text-muted hover:text-ink"><IconX size={18} /></button>
          </div>
          <p className="mb-4 text-xs text-muted">
            Only the bill's address details and notes change. The amount, quantity and
            rate are locked from the sale and can’t be edited here.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Bill to (name)" value={form.bill_to_name} onChange={(v) => setForm({ ...form, bill_to_name: v })} placeholder={sale.buyer?.full_name || ''} />
            <Field label="Buyer GSTIN" value={form.bill_to_gstin} onChange={(v) => setForm({ ...form, bill_to_gstin: v })} placeholder={sale.buyer?.gstin || ''} />
            <Field label="Billing address" value={form.bill_to_address} onChange={(v) => setForm({ ...form, bill_to_address: v })} placeholder={sale.buyer?.address || ''} full />
            <Field label="State name" value={form.bill_to_state_name} onChange={(v) => setForm({ ...form, bill_to_state_name: v })} />
            <Field label="State code" value={form.bill_to_state_code} onChange={(v) => setForm({ ...form, bill_to_state_code: v })} />
            <Field label="Invoice note" value={form.notes} onChange={(v) => setForm({ ...form, notes: v })} full />
          </div>
          <div className="mt-4 flex gap-3">
            <Button onClick={saveInvoice} disabled={saving}>
              <IconDeviceFloppy size={18} /> {saving ? 'Saving…' : 'Save'}
            </Button>
            <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </div>
      )}

      <div className="no-print flex flex-wrap items-center gap-3">
        <Link to={`/owner/orders/${sale.order_id}`} className="inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-ink">
          <IconReceipt2 size={17} /> View original order
        </Link>
      </div>

      {err && sale && <p className="no-print rounded-lg bg-dues/10 px-4 py-3 text-sm text-dues">{err}</p>}

      {/* Hidden on screen; the only thing inked by window.print() (SPEC §13). */}
      <SupplySlip job={slip} shop={shop} />
    </div>
  )
}

function Row({ label, value }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-ink">{value}</dd>
    </div>
  )
}

function Field({ label, value, onChange, placeholder, full }) {
  return (
    <label className={`block text-sm ${full ? 'sm:col-span-2' : ''}`}>
      <span className="text-xs text-muted">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1 w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm outline-none focus:border-peacock"
      />
    </label>
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
