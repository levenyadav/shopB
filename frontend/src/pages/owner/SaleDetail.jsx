import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  IconArrowLeft, IconPhoto, IconPrinter, IconMapPin, IconReceipt2,
  IconShare, IconDownload,
} from '@tabler/icons-react'
import { supabase } from '../../lib/supabase'
import { useShop } from '../../context/ShopContext'
import { money, qty, dateTime } from '../../lib/format'
import { round2, gstBreakup } from '../../lib/helpers'
import { buildSlipPdf, buildInvoicePdf, sharePdf, downloadPdf } from '../../lib/pdf'
import { Button, Badge, Spinner } from '../../components/ui'
import SupplySlip from '../../components/SupplySlip'
import { PAYMENT_META } from './Sales'

// SPEC §6.5 / §13.1 — one sale, with the owner-only economics (cost, profit) and
// a reprint of the Order Supply Slip. Read-only: a sale is the immutable record
// written at approval (rate locked, Golden Rule #5). The slip block is hidden on
// screen and is the only thing inked when printing (@media print in index.css).
export default function SaleDetail() {
  const { id } = useParams()
  const { shop, currency } = useShop()
  const [sale, setSale] = useState(null)
  const [err, setErr] = useState('')
  const [missing, setMissing] = useState(false)

  async function load() {
    setErr('')
    const { data, error } = await supabase
      .from('sales')
      .select(
        'id, order_id, quantity, rate_charged, amount, purchase_rate, profit, payment_type, buyer_type, created_at, ' +
          'item:items(name, item_no, photo_url, location), ' +
          'buyer:profiles!sales_buyer_id_fkey(full_name, phone, balance_due, gstin, address), ' +
          'category:categories(name), ' +
          'order:orders!sales_order_id_fkey(notes, created_at)',
      )
      .eq('id', id)
      .maybeSingle()
    if (error) setErr(error.message)
    else if (!data) setMissing(true)
    else setSale(data)
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

  // Customer invoice data — buyer-facing figures only (Golden Rule #4). GST is
  // applied only when the shop is GST-registered; gstBreakup is tax-inclusive so
  // the grand total equals the locked sale amount (Rule #5).
  const ref = sale.order_id?.slice(0, 8).toUpperCase()
  const invoice = {
    number: 'INV-' + ref,
    date: sale.created_at,
    buyer: {
      name: sale.buyer?.full_name,
      phone: sale.buyer?.phone,
      type: sale.buyer_type,
      gstin: sale.buyer?.gstin,
      address: sale.buyer?.address,
    },
    lines: [{
      item_no: item?.item_no,
      name: item?.name,
      qty: sale.quantity,
      rate: sale.rate_charged,
      amount: sale.amount,
    }],
    gst: shop?.gstin ? gstBreakup(sale.amount, shop?.gst_rate) : null,
    total: sale.amount,
  }
  const slipFile = `supply-slip-${ref}.pdf`
  const invoiceFile = `invoice-${ref}.pdf`

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
            <p className="text-xs text-muted">Sold {dateTime(sale.created_at)}</p>
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

        {/* Owner-only economics (Golden Rules #3, #4 — never on the slip) */}
        <div className="mt-4 flex flex-wrap items-center gap-4 rounded-lg bg-paper-2 px-4 py-3 text-sm">
          <span className="text-muted">Cost <span className="fig text-ink">{money(cost).replace('₹', currency)}</span></span>
          <span className="text-muted">Profit <span className="fig font-semibold text-profit">{money(sale.profit).replace('₹', currency)}</span></span>
          {sale.payment_type === 'udhaar' && (
            <span className="text-muted">Buyer udhaar now <span className="fig text-dues">{money(sale.buyer?.balance_due).replace('₹', currency)}</span></span>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="no-print flex flex-wrap items-center gap-3">
        <Button onClick={() => sharePdf(buildInvoicePdf(invoice, shop), invoiceFile, `Invoice ${invoice.number}`)}>
          <IconShare size={18} /> Share invoice
        </Button>
        <Button variant="ghost" onClick={() => downloadPdf(buildInvoicePdf(invoice, shop), invoiceFile)}>
          <IconDownload size={18} /> Download invoice
        </Button>
        <Button variant="ghost" onClick={() => sharePdf(buildSlipPdf(slip, shop), slipFile, `Supply slip #${ref}`)}>
          <IconShare size={18} /> Share slip
        </Button>
        <Button variant="ghost" onClick={() => window.print()}>
          <IconPrinter size={18} /> Reprint supply slip
        </Button>
        <Link to={`/owner/orders/${sale.order_id}`} className="inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-ink">
          <IconReceipt2 size={17} /> View original order
        </Link>
      </div>

      {err && sale && <p className="no-print rounded-lg bg-dues/10 px-4 py-3 text-sm text-dues">{err}</p>}

      {/* Hidden on screen; the only thing inked when printing (SPEC §13). */}
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
