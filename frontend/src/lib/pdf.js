// Client-side PDF generation + sharing for slips and invoices (SPEC §14.3).
// Built programmatically with jsPDF (no html2canvas) so output is crisp text and
// the bundle stays small. The WhatsApp use-case is served by sharePdf(), which
// hands a real File to the device share sheet and falls back to download.
//
// Golden Rule #4: these documents are buyer-facing — never pass purchase_rate or
// profit into them. Callers build the data shape from buyer-facing figures only.
import { jsPDF } from 'jspdf'
import { qty, dateTime, dateShort } from './format'

// Standard PDF fonts (Helvetica) have no ₹ glyph, so it would print blank.
// Render rupees as "Rs" and pass through any ASCII symbol (e.g. $) as-is.
function fmtAmount(n, currency = '₹') {
  const sym = currency === '₹' ? 'Rs ' : currency
  return sym + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })
}

// A4 portrait, millimetres. Shared margins.
const M = 16          // left/right margin
const W = 210         // page width
const RIGHT = W - M

function newDoc() {
  return new jsPDF({ unit: 'mm', format: 'a4' })
}

// ---------------------------------------------------------------------------
// Order Supply Slip (SPEC §13.1) — internal packing slip, now as a PDF.
// Mirrors components/SupplySlip.jsx. `job` is the same shape SupplySlip takes.
// ---------------------------------------------------------------------------
const PAYMENT_LABEL = { cash: 'Cash', upi: 'UPI', udhaar: 'Udhaar (credit)' }

export function buildSlipPdf(job, shop) {
  const doc = newDoc()
  const currency = shop?.currency_symbol || '₹'
  const ref = job.order_id?.slice(0, 8).toUpperCase()
  let y = 20

  y = shopHeader(doc, shop, y)
  y = centerTitle(doc, 'ORDER SUPPLY SLIP', y)

  y = row(doc, 'Slip printed', dateTime(new Date().toISOString()), y)
  y = row(doc, 'Order placed', dateTime(job.ordered_at), y)
  y = row(doc, 'Order ref', '#' + (ref || '—'), y)
  y = divider(doc, y)

  y = row(doc, 'Buyer', `${job.buyer_name || '—'} (${job.buyer_type || '—'})`, y)
  y = row(doc, 'Phone', job.buyer_phone || '—', y)
  y = divider(doc, y)

  y = row(doc, 'Item', job.item_name || '—', y)
  y = row(doc, 'Item No', job.item_no || '—', y)
  y = row(doc, 'Location / Rack', job.location || '—', y)
  y = divider(doc, y)

  y = row(doc, 'Quantity', `${qty(job.quantity)} pcs`, y)
  y = row(doc, 'Rate (each)', fmtAmount(job.rate_at_order, currency), y)
  y = row(doc, 'Total amount', fmtAmount(job.amount, currency), y, { bold: true })
  y = row(doc, 'Payment', PAYMENT_LABEL[job.payment_type] || '—', y)

  if (job.notes) {
    y = divider(doc, y)
    y = wrapped(doc, `Buyer note: ${job.notes}`, y)
  }

  y = divider(doc, y)
  signatures(doc, y + 10, ['Packed by (sign)', 'Received by (sign)'])
  return doc
}

// ---------------------------------------------------------------------------
// Customer Invoice (SPEC §15) — buyer-facing bill. GST is optional: when the
// shop has a GSTIN + rate, an `invoice.gst` breakup (from helpers.gstBreakup) is
// printed; otherwise it's a plain bill. `lines` is an array so a future
// multi-item order prints multiple rows unchanged.
// ---------------------------------------------------------------------------
export function buildInvoicePdf(invoice, shop) {
  const doc = newDoc()
  const currency = shop?.currency_symbol || '₹'
  const hasGst = !!invoice.gst
  let y = 20

  y = shopHeader(doc, shop, y)
  if (shop?.gstin) y = centerLine(doc, `GSTIN: ${shop.gstin}`, y, 9)
  y = centerTitle(doc, hasGst ? 'TAX INVOICE' : 'INVOICE', y)

  // Invoice meta (number + date), left aligned.
  doc.setFontSize(10)
  y = row(doc, 'Invoice no', invoice.number, y)
  y = row(doc, 'Date', dateShort(invoice.date), y)
  y = divider(doc, y)

  // Bill To block.
  doc.setFont('helvetica', 'bold'); doc.setFontSize(10)
  doc.text('Bill To', M, y); y += 5
  doc.setFont('helvetica', 'normal')
  y = wrapped(doc, `${invoice.buyer.name || '—'} (${invoice.buyer.type || 'customer'})`, y)
  if (invoice.buyer.phone) y = wrapped(doc, `Phone: ${invoice.buyer.phone}`, y)
  if (invoice.buyer.address) y = wrapped(doc, invoice.buyer.address, y)
  if (invoice.buyer.gstin) y = wrapped(doc, `GSTIN: ${invoice.buyer.gstin}`, y)
  y = divider(doc, y + 1)

  // Line items table.
  y = lineItems(doc, invoice.lines, currency, y)
  y = divider(doc, y)

  // Totals (right aligned). With GST, show taxable + CGST + SGST then grand
  // total; otherwise just the total. Grand total always equals invoice.total.
  if (hasGst) {
    y = totalLine(doc, `Taxable value`, fmtAmount(invoice.gst.taxable, currency), y)
    y = totalLine(doc, `CGST (${invoice.gst.rate / 2}%)`, fmtAmount(invoice.gst.cgst, currency), y)
    y = totalLine(doc, `SGST (${invoice.gst.rate / 2}%)`, fmtAmount(invoice.gst.sgst, currency), y)
  }
  y = totalLine(doc, 'Grand total', fmtAmount(invoice.total, currency), y, { bold: true })

  // Footer note.
  doc.setFontSize(9); doc.setTextColor(120)
  doc.text('Thank you for your business.', M, Math.min(y + 14, 285))
  doc.setTextColor(0)
  return doc
}

// ---------------------------------------------------------------------------
// Share or download. Tries the native file share sheet first (mobile →
// WhatsApp); falls back to a normal download on desktop or if the user cancels.
// Returns 'shared' | 'cancelled' | 'downloaded'.
// ---------------------------------------------------------------------------
export async function sharePdf(doc, filename, text) {
  const blob = doc.output('blob')
  const file = new File([blob], filename, { type: 'application/pdf' })
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: text, text })
      return 'shared'
    } catch (err) {
      if (err && err.name === 'AbortError') return 'cancelled'
      // any other share error → fall through to download
    }
  }
  doc.save(filename)
  return 'downloaded'
}

export function downloadPdf(doc, filename) {
  doc.save(filename)
}

// ---------------------------------------------------------------------------
// Layout primitives (mm). Each returns the next y so callers can flow downward.
// ---------------------------------------------------------------------------
function shopHeader(doc, shop, y) {
  doc.setFont('helvetica', 'bold'); doc.setFontSize(16)
  doc.text(shop?.name || 'Shop', W / 2, y, { align: 'center' }); y += 6
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9)
  if (shop?.phone) { doc.text(String(shop.phone), W / 2, y, { align: 'center' }); y += 4.5 }
  if (shop?.address) {
    for (const ln of doc.splitTextToSize(String(shop.address), W - 2 * M)) {
      doc.text(ln, W / 2, y, { align: 'center' }); y += 4.5
    }
  }
  return y + 2
}

function centerTitle(doc, text, y) {
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11)
  doc.text(`— ${text} —`, W / 2, y + 4, { align: 'center' })
  doc.setFont('helvetica', 'normal')
  return y + 11
}

function centerLine(doc, text, y, size = 9) {
  doc.setFontSize(size)
  doc.text(text, W / 2, y, { align: 'center' })
  return y + 4.5
}

function row(doc, label, value, y, { bold = false } = {}) {
  doc.setFontSize(10)
  doc.setTextColor(110); doc.text(String(label), M, y)
  doc.setTextColor(0)
  doc.setFont('helvetica', bold ? 'bold' : 'normal')
  doc.text(String(value), RIGHT, y, { align: 'right' })
  doc.setFont('helvetica', 'normal')
  return y + 6
}

function totalLine(doc, label, value, y, { bold = false } = {}) {
  doc.setFontSize(bold ? 11 : 10)
  doc.setFont('helvetica', bold ? 'bold' : 'normal')
  doc.text(String(label), RIGHT - 50, y, { align: 'right' })
  doc.text(String(value), RIGHT, y, { align: 'right' })
  doc.setFont('helvetica', 'normal')
  return y + (bold ? 7 : 6)
}

function lineItems(doc, lines, currency, y) {
  // Column header.
  doc.setFontSize(9); doc.setTextColor(110)
  doc.text('Item', M, y)
  doc.text('Qty', 120, y, { align: 'right' })
  doc.text('Rate', 160, y, { align: 'right' })
  doc.text('Amount', RIGHT, y, { align: 'right' })
  doc.setTextColor(0); y += 2
  y = divider(doc, y)
  doc.setFontSize(10)
  for (const ln of lines) {
    const name = doc.splitTextToSize(String(ln.name || '—'), 95)
    doc.text(name, M, y)
    if (ln.item_no) {
      doc.setFontSize(8); doc.setTextColor(130)
      doc.text(String(ln.item_no), M, y + 4)
      doc.setTextColor(0); doc.setFontSize(10)
    }
    doc.text(`${qty(ln.qty)}`, 120, y, { align: 'right' })
    doc.text(fmtAmount(ln.rate, currency), 160, y, { align: 'right' })
    doc.text(fmtAmount(ln.amount, currency), RIGHT, y, { align: 'right' })
    y += Math.max(name.length * 4.5, ln.item_no ? 8 : 6) + 1
  }
  return y
}

function wrapped(doc, text, y) {
  doc.setFontSize(10)
  for (const ln of doc.splitTextToSize(String(text), W - 2 * M)) {
    doc.text(ln, M, y); y += 4.8
  }
  return y
}

function divider(doc, y) {
  doc.setDrawColor(200)
  doc.line(M, y, RIGHT, y)
  return y + 5
}

function signatures(doc, y, labels) {
  doc.setDrawColor(0)
  doc.line(M, y, M + 50, y)
  doc.line(RIGHT - 50, y, RIGHT, y)
  doc.setFontSize(9)
  doc.text(labels[0], M, y + 5)
  doc.text(labels[1], RIGHT, y + 5, { align: 'right' })
}
