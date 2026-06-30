// A5 customer Tax Invoice (SPEC §15; client feat #4/#6/#7). Rendered as a
// self-contained HTML document and printed via a hidden iframe — the same
// no-popup pattern as barcodeLabel.js — so "Download" is the browser's native
// Print → Save as PDF, with no heavy PDF library and a crisp, true-to-paper A5.
//
// Layout mirrors the shop's familiar Tally "Tax Invoice": boxed seller / Bill-To
// / Ship-To header, a meta grid (Invoice No, Dated, and the standard — usually
// blank — logistics boxes), an itemised table, the GST break-up, an HSN-wise tax
// summary, amounts in words, and the PAN / declaration / signatory footer.
//
// Golden Rule #4: this is buyer-facing. Callers build `lines` from buyer figures
// only (rate_charged / amount) — never purchase_rate or profit.
//
// GST model (Golden Rule #5): the sale amount is LOCKED and is what the buyer
// pays, so it is the tax-INCLUSIVE grand total. Like the reference bill, each
// line shows the inclusive Rate (MRP) and a taxable Amount, with the tax backed
// out into CGST + SGST (intra-state, split in half). The grand total therefore
// always equals the locked sale amount — editing the invoice never changes it.

import { round2, gstBreakup } from './helpers'

// ---------------------------------------------------------------------------
// Number → Indian-system words, for "Amount Chargeable (in words)".
// ---------------------------------------------------------------------------
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight',
  'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
  'Seventeen', 'Eighteen', 'Nineteen']
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']

function twoDigits(n) {
  if (n < 20) return ONES[n]
  const t = Math.floor(n / 10), o = n % 10
  return TENS[t] + (o ? ' ' + ONES[o] : '')
}

// 0–999 → words.
function threeDigits(n) {
  const h = Math.floor(n / 100), rest = n % 100
  let s = ''
  if (h) s += ONES[h] + ' Hundred'
  if (rest) s += (s ? ' ' : '') + twoDigits(rest)
  return s
}

// Indian grouping: crore, lakh, thousand, then the last three digits.
function intToWords(n) {
  if (n === 0) return 'Zero'
  const crore = Math.floor(n / 10000000); n %= 10000000
  const lakh = Math.floor(n / 100000); n %= 100000
  const thou = Math.floor(n / 1000); n %= 1000
  const parts = []
  if (crore) parts.push(threeDigits(crore) + ' Crore')
  if (lakh) parts.push(twoDigits(lakh) + ' Lakh')
  if (thou) parts.push(twoDigits(thou) + ' Thousand')
  if (n) parts.push(threeDigits(n))
  return parts.join(' ')
}

// "INR Five Thousand Five Only" / "... and Fifty Paise Only".
export function amountInWords(amount, currencyWord = 'INR') {
  const rupees = Math.floor(round2(amount))
  const paise = Math.round((round2(amount) - rupees) * 100)
  let s = `${currencyWord} ${intToWords(rupees)}`
  if (paise) s += ` and ${twoDigits(paise)} Paise`
  return s + ' Only'
}

// ---------------------------------------------------------------------------
// Normalise raw data into a render-ready model. `lines[].rate` is the inclusive
// per-unit price (rate_charged); `gstRate` is the shop's single rate (0 = none).
// ---------------------------------------------------------------------------
export function buildInvoiceModel({ shop, buyer, consignee, invoice, lines, gstRate }) {
  const rate = Number(gstRate || 0)
  const hasGst = rate > 0 && !!shop?.gstin
  // Per-line: inclusive line total, then the taxable portion backed out of it.
  const rows = lines.map((ln, i) => {
    const inclusive = round2(Number(ln.qty) * Number(ln.rate))
    const taxable = hasGst ? round2(inclusive / (1 + rate / 100)) : inclusive
    // "Disc. %" on the reference bill is the GST-extraction fraction (MRP→taxable).
    const discPct = hasGst ? round2((1 - 1 / (1 + rate / 100)) * 100) : 0
    return {
      sl: i + 1,
      name: ln.name || '—',
      item_no: ln.item_no || '',
      hsn: ln.hsn || '',
      qty: Number(ln.qty),
      rate: Number(ln.rate),
      discPct,
      taxable,
      amount: inclusive,
    }
  })

  const grandTotal = round2(rows.reduce((s, r) => s + r.amount, 0))
  const gst = hasGst ? gstBreakup(grandTotal, rate) : null

  // HSN-wise tax summary — only rows that carry an HSN/SAC code (optional).
  let hsnSummary = null
  if (hasGst && rows.some((r) => r.hsn)) {
    const byHsn = new Map()
    for (const r of rows) {
      const key = r.hsn || '—'
      const acc = byHsn.get(key) || { hsn: key, taxable: 0 }
      acc.taxable = round2(acc.taxable + r.taxable)
      byHsn.set(key, acc)
    }
    const half = rate / 2
    hsnSummary = [...byHsn.values()].map((h) => {
      const tax = round2(h.taxable * rate / 100)
      const cgst = round2(tax / 2)
      return { ...h, halfRate: half, cgst, sgst: round2(tax - cgst), total: tax }
    })
  }

  const anyHsn = rows.some((r) => r.hsn)
  return {
    currency: shop?.currency_symbol || '₹',
    number: invoice?.invoice_no || '—',
    date: invoice?.date,
    seller: {
      name: shop?.legal_name || shop?.name || 'Shop',
      address: shop?.address,
      phone: shop?.phone,
      email: shop?.email,
      gstin: shop?.gstin,
      pan: shop?.pan,
      state_name: shop?.state_name,
      state_code: shop?.state_code,
      bank: shop?.bank_details,
    },
    buyer,
    consignee: consignee || buyer, // Ship-To defaults to Bill-To
    rows,
    anyHsn,
    gst,
    hsnSummary,
    grandTotal,
    notes: invoice?.notes,
    words: amountInWords(grandTotal),
    taxWords: gst ? amountInWords(gst.tax) : null,
  }
}

// ---------------------------------------------------------------------------
// HTML rendering.
// ---------------------------------------------------------------------------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}

function fmt(n, currency) {
  return currency + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// "State Name : Uttar Pradesh, Code : 09" — only the parts that exist.
function stateLine(p) {
  if (!p?.state_name && !p?.state_code) return ''
  const name = p.state_name ? esc(p.state_name) : ''
  const code = p.state_code ? `, Code : ${esc(p.state_code)}` : ''
  return `<div>State Name&nbsp;: ${name}${code}</div>`
}

function partyBlock(label, p) {
  return `
    <div class="party-label">${label}</div>
    <div class="party-name">${esc(p?.name || '—')}</div>
    ${p?.address ? `<div>${esc(p.address)}</div>` : ''}
    ${p?.gstin ? `<div>GSTIN/UIN : ${esc(p.gstin)}</div>` : ''}
    ${stateLine(p)}`
}

// The right-hand meta grid. Most boxes are standard Tally fields left blank, kept
// for the familiar look (the owner chose the full replica).
function metaGrid(m) {
  const dated = m.date ? new Date(m.date).toLocaleDateString('en-IN',
    { day: '2-digit', month: 'short', year: '2-digit' }) : ''
  const cell = (label, value = '') =>
    `<td><span class="mk">${label}</span><span class="mv">${esc(value)}</span></td>`
  return `
    <table class="meta">
      <tr>${cell('Invoice No.', m.number)}${cell('Dated', dated)}</tr>
      <tr>${cell('Delivery Note')}${cell('Mode/Terms of Payment')}</tr>
      <tr>${cell('Reference No. & Date.')}${cell('Other References')}</tr>
      <tr>${cell("Buyer's Order No.")}${cell('Dated')}</tr>
      <tr>${cell('Dispatch Doc No.')}${cell('Delivery Note Date')}</tr>
      <tr>${cell('Dispatched through')}${cell('Destination')}</tr>
      <tr><td colspan="2"><span class="mk">Terms of Delivery</span></td></tr>
    </table>`
}

function itemRows(m) {
  const c = m.currency
  const cols = m.anyHsn ? 8 : 7
  const body = m.rows.map((r) => `
    <tr>
      <td class="c">${r.sl}</td>
      <td class="desc"><b>${esc(r.name)}</b>${r.item_no ? `<span class="muted"> · ${esc(r.item_no)}</span>` : ''}</td>
      ${m.anyHsn ? `<td class="c">${esc(r.hsn)}</td>` : ''}
      <td class="r nowrap">${r.qty} pcs</td>
      <td class="r">${fmt(r.rate, c)}</td>
      <td class="c">pcs</td>
      ${m.gst ? `<td class="r">${r.discPct}%</td>` : ''}
      <td class="r">${fmt(m.gst ? r.taxable : r.amount, c)}</td>
    </tr>`).join('')

  // Tax lines + grand total, echoing the reference's in-table block.
  const taxBlock = m.gst ? `
    <tr class="tax">
      <td></td><td class="desc r">OUTPUT CGST @ ${m.gst.rate / 2}%</td>
      ${m.anyHsn ? '<td></td>' : ''}<td></td><td></td><td></td>${m.gst ? '<td></td>' : ''}
      <td class="r">${fmt(m.gst.cgst, c)}</td>
    </tr>
    <tr class="tax">
      <td></td><td class="desc r">OUTPUT SGST @ ${m.gst.rate / 2}%</td>
      ${m.anyHsn ? '<td></td>' : ''}<td></td><td></td><td></td>${m.gst ? '<td></td>' : ''}
      <td class="r">${fmt(m.gst.sgst, c)}</td>
    </tr>` : ''

  const totalQty = m.rows.reduce((s, r) => s + r.qty, 0)
  return `
    <table class="items">
      <thead>
        <tr>
          <th class="c">Sl</th><th>Description of Goods</th>
          ${m.anyHsn ? '<th class="c">HSN/SAC</th>' : ''}
          <th class="r">Quantity</th><th class="r">Rate</th><th class="c">per</th>
          ${m.gst ? '<th class="r">Disc. %</th>' : ''}
          <th class="r">Amount</th>
        </tr>
      </thead>
      <tbody>
        ${body}
        ${taxBlock}
        <tr class="spacer"><td colspan="${cols}"></td></tr>
      </tbody>
      <tfoot>
        <tr class="grand">
          <td></td><td class="r">Total</td>
          ${m.anyHsn ? '<td></td>' : ''}
          <td class="r nowrap">${totalQty} pcs</td><td></td><td></td>
          ${m.gst ? '<td></td>' : ''}
          <td class="r"><b>${fmt(m.grandTotal, c)}</b></td>
        </tr>
      </tfoot>
    </table>`
}

function hsnSummaryTable(m) {
  if (!m.hsnSummary) return ''
  const c = m.currency
  const rows = m.hsnSummary.map((h) => `
    <tr>
      <td>${esc(h.hsn)}</td>
      <td class="r">${fmt(h.taxable, c)}</td>
      <td class="c">${h.halfRate}%</td><td class="r">${fmt(h.cgst, c)}</td>
      <td class="c">${h.halfRate}%</td><td class="r">${fmt(h.sgst, c)}</td>
      <td class="r">${fmt(h.total, c)}</td>
    </tr>`).join('')
  return `
    <table class="hsn">
      <thead>
        <tr>
          <th rowspan="2">HSN/SAC</th><th rowspan="2" class="r">Taxable<br/>Value</th>
          <th colspan="2">CGST</th><th colspan="2">SGST/UTGST</th>
          <th rowspan="2" class="r">Total<br/>Tax Amount</th>
        </tr>
        <tr><th>Rate</th><th class="r">Amount</th><th>Rate</th><th class="r">Amount</th></tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr>
          <td class="r">Total</td>
          <td class="r">${fmt(m.gst.taxable, c)}</td>
          <td></td><td class="r">${fmt(m.gst.cgst, c)}</td>
          <td></td><td class="r">${fmt(m.gst.sgst, c)}</td>
          <td class="r">${fmt(m.gst.tax, c)}</td>
        </tr>
      </tfoot>
    </table>`
}

export function invoiceHtml(model) {
  const m = model
  const s = m.seller
  const title = m.gst ? 'Tax Invoice' : 'Invoice'
  return `<!doctype html>
<html><head><meta charset="utf-8"/><title>${esc(title)} ${esc(m.number)}</title>
<style>
  @page { size: A5 portrait; margin: 6mm; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  html, body { margin: 0; padding: 0; }
  body { font-family: Arial, Helvetica, sans-serif; color: #000; font-size: 7.5pt; line-height: 1.25; }
  .doc { width: 136mm; margin: 0 auto; }
  .title { text-align: center; font-weight: 700; font-size: 10pt; margin-bottom: 2px; }
  .box { border: 1px solid #000; }
  table { border-collapse: collapse; width: 100%; }
  td, th { border: 1px solid #000; padding: 2px 4px; vertical-align: top; }
  .r { text-align: right; } .c { text-align: center; } .nowrap { white-space: nowrap; }
  .muted { color: #444; font-weight: 400; }

  /* Header: seller (left) + meta grid (right) */
  .head { display: flex; }
  .head .seller { width: 56%; border: 1px solid #000; border-right: 0; padding: 4px 6px; }
  .head .meta-wrap { width: 44%; }
  .seller .nm { font-weight: 700; font-size: 8.5pt; }
  table.meta td { height: 13px; }
  .mk { display: block; font-size: 6pt; color: #333; }
  .mv { display: block; font-weight: 700; }

  /* Parties */
  .parties { display: flex; border: 1px solid #000; border-top: 0; }
  .parties > div { width: 56%; padding: 4px 6px; }
  .parties .ship { width: 44%; border-left: 1px solid #000; }
  .party-label { font-size: 6.5pt; color: #333; }
  .party-name { font-weight: 700; }

  /* Items */
  table.items { border-top: 0; }
  table.items th { background: #f0f0f0; font-size: 6.5pt; }
  table.items td.desc { width: 44%; }
  tr.tax td { border-top: 0; border-bottom: 0; }
  tr.spacer td { height: 10px; border-top: 0; border-bottom: 0; }
  tr.grand td { font-weight: 700; border-top: 1px solid #000; }

  .words { border: 1px solid #000; border-top: 0; padding: 3px 6px; }
  .words b { font-size: 8pt; }
  table.hsn { border-top: 0; }
  table.hsn th { background: #f0f0f0; font-size: 6.5pt; }

  .foot { display: flex; border: 1px solid #000; border-top: 0; }
  .foot .decl { width: 60%; padding: 4px 6px; border-right: 1px solid #000; }
  .foot .sign { width: 40%; padding: 4px 6px; text-align: right; position: relative; }
  .foot .sign .for { font-weight: 700; }
  .foot .sign .line { margin-top: 30px; font-size: 6.5pt; }
  .cgi { text-align: center; font-size: 6.5pt; margin-top: 3px; color: #333; }
</style></head>
<body><div class="doc">
  <div class="title">${esc(title)}</div>

  <div class="head">
    <div class="seller">
      <div class="nm">${esc(s.name)}</div>
      ${s.address ? `<div>${esc(s.address)}</div>` : ''}
      ${s.phone ? `<div>Mob. : ${esc(s.phone)}</div>` : ''}
      ${s.gstin ? `<div>GSTIN/UIN: ${esc(s.gstin)}</div>` : ''}
      ${s.pan ? `<div>PAN : ${esc(s.pan)}</div>` : ''}
      ${stateLine(s)}
      ${s.email ? `<div>E-Mail : ${esc(s.email)}</div>` : ''}
    </div>
    <div class="meta-wrap box" style="border-left:0">${metaGrid(m)}</div>
  </div>

  <div class="parties">
    <div class="bill">${partyBlock('Buyer (Bill to)', m.buyer)}</div>
    <div class="ship">${partyBlock('Consignee (Ship to)', m.consignee)}</div>
  </div>

  ${itemRows(m)}

  <div class="words">
    <div style="font-size:6.5pt;color:#333">Amount Chargeable (in words)</div>
    <b>${esc(m.words)}</b>
  </div>

  ${hsnSummaryTable(m)}
  ${m.taxWords ? `<div class="words"><div style="font-size:6.5pt;color:#333">Tax Amount (in words)</div><b>${esc(m.taxWords)}</b></div>` : ''}
  ${m.notes ? `<div class="words"><div style="font-size:6.5pt;color:#333">Note</div>${esc(m.notes)}</div>` : ''}

  <div class="foot">
    <div class="decl">
      ${s.pan ? `<div>Company's PAN : <b>${esc(s.pan)}</b></div>` : ''}
      ${s.bank ? `<div>${esc(s.bank)}</div>` : ''}
      <div style="margin-top:3px;font-size:6.5pt;color:#333">Declaration</div>
      <div>We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.</div>
    </div>
    <div class="sign">
      <div class="for">for ${esc(s.name)}</div>
      <div class="line">Authorised Signatory</div>
    </div>
  </div>
  <div class="cgi">This is a Computer Generated Invoice</div>
</div></body></html>`
}

// ---------------------------------------------------------------------------
// Print (→ Save as PDF) via a hidden iframe, mirroring barcodeLabel.js.
// ---------------------------------------------------------------------------
export function printInvoice(model) {
  const html = invoiceHtml(model)
  const iframe = document.createElement('iframe')
  iframe.setAttribute('aria-hidden', 'true')
  Object.assign(iframe.style, {
    position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0',
  })
  document.body.appendChild(iframe)
  const doc = iframe.contentWindow.document
  doc.open(); doc.write(html); doc.close()
  setTimeout(() => {
    iframe.contentWindow.focus()
    iframe.contentWindow.print()
    setTimeout(() => iframe.remove(), 1000)
  }, 150)
}

// Open the invoice in a new tab for on-screen viewing (no auto-print).
export function viewInvoice(model) {
  const w = window.open('', '_blank')
  if (!w) { printInvoice(model); return } // popup blocked → fall back to print
  w.document.open(); w.document.write(invoiceHtml(model)); w.document.close()
}
