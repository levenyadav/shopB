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

// Every column a sale LINE needs here — used both for the line the URL names
// and for its siblings on the same bill.
const SALE_COLS =
  'id, order_id, bill_id, quantity, rate_charged, amount, purchase_rate, profit, payment_type, buyer_type, created_at, ' +
  'item_no, item_name, ' +
  'item:items(name, item_no, photo_url, location, hsn_sac, gst_rate), ' +
  'buyer:profiles!sales_buyer_id_fkey(full_name, phone, balance_due, gstin, address, state_name, state_code), ' +
  'category:categories(name), ' +
  'order:orders!sales_order_id_fkey(notes, created_at, order_group_id)'

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
  const [bill, setBill] = useState(null)
  const [lines, setLines] = useState([])
  const [picks, setPicks] = useState([])
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

  // A bill is rarely one line. A counter bill shares `bill_id` (014) and a cart
  // shares `orders.order_group_id` (018) — one invoice number over several sale
  // rows. The sale the URL names is only the FIRST of them (party_bills hands
  // out the earliest row as detail_ref), so load its siblings: this page and the
  // Tax Invoice must show the whole document, not one line of it.
  async function loadLines(saleRow) {
    let rows = null
    if (saleRow.bill_id) {
      const { data } = await supabase.from('sales').select(SALE_COLS)
        .eq('bill_id', saleRow.bill_id).order('created_at')
      rows = data
    } else if (saleRow.order?.order_group_id) {
      const { data: ords } = await supabase.from('orders')
        .select('id').eq('order_group_id', saleRow.order.order_group_id)
      const ids = (ords ?? []).map((o) => o.id)
      if (ids.length > 1) {
        const { data } = await supabase.from('sales').select(SALE_COLS)
          .in('order_id', ids).order('created_at')
        rows = data
      }
    }
    const billLines = rows?.length ? rows : [saleRow]
    setLines(billLines)
    loadBill(billLines)
  }

  // The finalize-bill breakdown (023): discount + shipping/packing/other, shown
  // as adjustment lines on the invoice. order_bills holds one row PER LINE (a
  // cart discount is split across its lines, 051), so a bill's charges are the
  // sum over its lines.
  async function loadBill(billLines) {
    const { data } = await supabase
      .from('order_bills')
      .select('subtotal, discount_amount, shipping_fee, packing_fee, other_charge, grand_total')
      .in('sale_id', billLines.map((l) => l.id))
    if (!data?.length) { setBill(null); return }
    const sum = (k) => round2(data.reduce((t, r) => t + Number(r[k] || 0), 0))
    setBill({
      subtotal: sum('subtotal'), discount_amount: sum('discount_amount'),
      shipping_fee: sum('shipping_fee'), packing_fee: sum('packing_fee'),
      other_charge: sum('other_charge'), grand_total: sum('grand_total'),
    })
  }

  // Which warehouses this sale's stock actually came from (050) — a reprinted
  // supply slip must show the same split the packer was given.
  async function loadPicks(saleRow) {
    const { data } = await supabase
      .from('fulfilment_picks')
      .select('warehouse, quantity')
      .eq('sale_id', saleRow.id)
      .order('quantity', { ascending: false })
    setPicks(data ?? [])
  }

  async function load() {
    setErr('')
    const { data, error } = await supabase
      .from('sales')
      .select(SALE_COLS)
      .eq('id', id)
      .maybeSingle()
    if (error) setErr(error.message)
    else if (!data) setMissing(true)
    else { setSale(data); loadInvoice(data); loadLines(data); loadPicks(data) }
  }
  useEffect(() => { setLines([]); load() }, [id])

  if (missing) return <Empty>Sale not found. <Link to="/owner/sales" className="font-medium text-peacock hover:underline">Back to sales</Link>.</Empty>
  if (err && !sale) return <Empty>{err}</Empty>
  if (!sale) return <div className="grid place-items-center py-20 text-muted"><Spinner /></div>

  const item = sale.item
  const pay = PAYMENT_META[sale.payment_type] || { label: sale.payment_type, tone: 'muted' }

  // Whole bill, not just the line in the URL. Until the siblings land, the one
  // line we have IS the bill as far as the page is concerned.
  const billLines = lines.length ? lines : [sale]
  const multi = billLines.length > 1
  const sumBy = (fn) => round2(billLines.reduce((t, l) => t + fn(l), 0))
  const billQty = sumBy((l) => Number(l.quantity || 0))
  const billAmount = sumBy((l) => Number(l.amount || 0))
  const cost = sumBy((l) => Number(l.purchase_rate || 0) * Number(l.quantity || 0))
  const billProfit = sumBy((l) => Number(l.profit || 0))

  // Reshape the sale into the shape SupplySlip expects (it was built for the
  // fulfilment_queue view). Buyer-facing figures only — never cost/profit.
  const slip = {
    order_id: sale.order_id,
    ordered_at: sale.order?.created_at || sale.created_at,
    buyer_name: sale.buyer?.full_name,
    buyer_type: sale.buyer_type,
    buyer_phone: sale.buyer?.phone,
    item_name: item?.name || sale.item_name,
    item_no: item?.item_no || sale.item_no,
    location: item?.location,
    quantity: sale.quantity,
    rate_at_order: sale.rate_charged,
    amount: sale.amount,
    payment_type: sale.payment_type,
    notes: sale.order?.notes,
    picks,
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
    lines: billLines.map((l) => ({
      name: l.item?.name || l.item_name, item_no: l.item?.item_no || l.item_no,
      hsn: l.item?.hsn_sac, gstRate: l.item?.gst_rate, qty: l.quantity, rate: l.rate_charged,
    })),
    bill,
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
            <p className="truncate text-lg font-semibold">
              {multi ? `Bill of ${billLines.length} items` : (item?.name || sale.item_name || 'Item')}
            </p>
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
          <Row label="Payment" value={<Badge tone={pay.tone}>{pay.label}</Badge>} />
          {!multi && <>
            <Row label="Category" value={sale.category?.name || '—'} />
            <Row label="Item No" value={<span className="fig">{item?.item_no || sale.item_no || '—'}</span>} />
            <Row label="Rack / Location" value={<span className="inline-flex items-center gap-1">{item?.location ? <><IconMapPin size={15} /> {item.location}</> : '—'}</span>} />
            <Row label={`${sale.buyer_type === 'dealer' ? 'Dealer ' : ''}rate (each)`} value={<span className="fig">{money(sale.rate_charged).replace('₹', currency)}</span>} />
          </>}
          <Row label="Quantity" value={<span className="fig">{qty(billQty)} pcs</span>} />
          <Row label={multi ? 'Bill total' : 'Amount'} value={<span className="fig font-semibold">{money(billAmount).replace('₹', currency)}</span>} />
        </dl>

        {/* Every line on this bill. Rate is the one locked at order time
            (Golden Rule #5) — the same figure the invoice prints. */}
        {multi && (
          <div className="mt-5 overflow-x-auto">
            <table className="w-full min-w-[26rem] text-sm">
              <thead>
                <tr className="border-b border-line text-xs text-muted">
                  <th className="py-2 text-left font-normal">Item</th>
                  <th className="py-2 text-right font-normal">Qty</th>
                  <th className="py-2 text-right font-normal">Rate</th>
                  <th className="py-2 text-right font-normal">Amount</th>
                </tr>
              </thead>
              <tbody>
                {billLines.map((l) => (
                  <tr key={l.id} className="border-b border-line/60">
                    <td className="py-2 pr-3">
                      <span className="text-ink">{l.item?.name || l.item_name || 'Item'}</span>
                      <span className="ml-2 fig text-xs text-muted">{l.item?.item_no || l.item_no || ''}</span>
                    </td>
                    <td className="fig py-2 text-right">{qty(l.quantity)}</td>
                    <td className="fig py-2 text-right">{money(l.rate_charged).replace('₹', currency)}</td>
                    <td className="fig py-2 text-right font-medium">{money(l.amount).replace('₹', currency)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td className="py-2 text-xs text-muted" colSpan={3}>Goods total</td>
                  <td className="fig py-2 text-right font-semibold">{money(billAmount).replace('₹', currency)}</td>
                </tr>
                {Number(bill?.discount_amount) > 0 && (
                  <tr>
                    <td className="py-1 text-xs text-muted" colSpan={3}>Less discount</td>
                    <td className="fig py-1 text-right">−{money(bill.discount_amount).replace('₹', currency)}</td>
                  </tr>
                )}
              </tfoot>
            </table>
          </div>
        )}

        {/* Owner-only economics (Golden Rules #3, #4 — never on slip or invoice) */}
        <div className="mt-4 flex flex-wrap items-center gap-4 rounded-lg bg-paper-2 px-4 py-3 text-sm">
          <span className="text-muted">Cost <span className="fig text-ink">{money(cost).replace('₹', currency)}</span></span>
          <span className="text-muted">Profit <span className="fig font-semibold text-profit">{money(billProfit).replace('₹', currency)}</span></span>
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
        {/* The supply slip is a PACKING job, and a job is one line (one item,
            one rack, one warehouse split) — so on a multi-line bill these two
            print the line this page was opened on, and say so. */}
        <Button variant="ghost" onClick={() => sharePdf(buildSlipPdf(slip, shop), slipFile, `Supply slip #${ref}`)}>
          <IconShare size={18} /> Share slip{multi ? ' (this item)' : ''}
        </Button>
        <Button variant="ghost" onClick={() => window.print()}>
          <IconReceipt2 size={18} /> Reprint slip{multi ? ' (this item)' : ''}
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
