// A5 Purchase Bill document (SPEC §13) — the shop's own structured record of a
// supplier bill, printed via a hidden iframe so "Download" is the browser's
// native Print → Save as PDF. Same machinery and the same Tally-style boxed
// layout as the customer Tax Invoice in invoiceTemplate.js, so the two documents
// look like they came from the same office.
//
// It is NOT the same tax model, which is why this is a sibling and not a call
// into buildInvoiceModel:
//
//   * A SALE's amount is locked and tax-INCLUSIVE, so that template backs CGST
//     and SGST out of the price the buyer already agreed to.
//   * A PURCHASE bill is tax-EXCLUSIVE: purchase_rate is the pre-tax goods rate
//     (migration 036) and the supplier adds postage and CGST/SGST on top:
//
//         goods + postage + cgst + sgst = grand total owed to the supplier
//
// This document is internal (Golden Rule #4 — it shows purchase rates, so it is
// never handed to a buyer). Postage is pass-through and the GST is claimable
// input credit; neither is part of an item's cost, and the totals block says so.
import { round2 } from './helpers'
import { amountInWords } from './invoiceTemplate'

// ---------------------------------------------------------------------------
// Normalise a loaded bill into a render-ready model.
// ---------------------------------------------------------------------------
export function buildPurchaseBillModel({ shop, bill }) {
  const rows = bill.lines.map((l, i) => ({
    sl: i + 1,
    name: l.item_name || l.item?.name || 'Item',
    item_no: l.item_no || l.item?.item_no || '',
    hsn: l.item?.hsn_sac || '',
    qty: Number(l.quantity || 0),
    rate: Number(l.purchase_rate || 0),
    amount: round2(Number(l.total_cost || 0)),
  }))

  const goods = round2(rows.reduce((s, r) => s + r.amount, 0))
  const postage = round2(bill.postage || 0)
  const cgst = round2(bill.cgst || 0)
  const sgst = round2(bill.sgst || 0)
  const tax = round2(cgst + sgst)
  const grand = round2(goods + postage + tax)

  // The charges rows carry amounts, not rates (036 records what the supplier
  // actually charged), so the slab is derived back from the money. Shown only
  // when it is a clean, recognisable figure — a derived "2.4713%" would be
  // noise, not information.
  const effRate = goods > 0 ? round2((tax / goods) * 100) : 0
  const cleanRate = Number.isInteger(effRate * 2) && effRate > 0 ? effRate : null

  return {
    currency: shop?.currency_symbol || '₹',
    number: bill.invoice_no || '—',
    date: bill.invoice_date || bill.createdAt,
    enteredAt: bill.createdAt,
    enteredBy: bill.enteredBy || '',
    // The letterhead is ours: this is our record of the bill, filed against the
    // supplier's paper copy.
    shop: {
      name: shop?.legal_name || shop?.name || 'Shop',
      address: shop?.address,
      phone: shop?.phone,
      email: shop?.email,
      gstin: shop?.gstin,
      pan: shop?.pan,
      state_name: shop?.state_name,
      state_code: shop?.state_code,
    },
    supplier: bill.supplier || null,
    rows,
    anyHsn: rows.some((r) => r.hsn),
    goods, postage, cgst, sgst, tax, grand,
    cleanRate,
    notes: bill.notes || '',
    words: amountInWords(grand),
    taxWords: tax > 0 ? amountInWords(tax) : null,
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

function dmy(ts) {
  if (!ts) return ''
  return new Date(ts).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' })
}

function stateLine(p) {
  if (!p?.state_name && !p?.state_code) return ''
  const name = p.state_name ? esc(p.state_name) : ''
  const code = p.state_code ? `, Code : ${esc(p.state_code)}` : ''
  return `<div>State Name&nbsp;: ${name}${code}</div>`
}

// Right-hand meta grid. Unlike the sale invoice this one is filled, not a set of
// blank Tally placeholders — every box here is something a purchase bill knows.
function metaGrid(m) {
  const cell = (label, value = '') =>
    `<td><span class="mk">${label}</span><span class="mv">${esc(value)}</span></td>`
  return `
    <table class="meta">
      <tr>${cell("Supplier's Bill No.", m.number)}${cell('Bill Date', dmy(m.date))}</tr>
      <tr>${cell('Entered On', dmy(m.enteredAt))}${cell('Entered By', m.enteredBy)}</tr>
      <tr>${cell('Supplier', m.supplier?.name || '')}${cell('Contact', m.supplier?.contact_person || '')}</tr>
      <tr>${cell('Phone', m.supplier?.phone || '')}${cell('Items', String(m.rows.length))}</tr>
      <tr><td colspan="2"><span class="mk">Terms of Delivery</span></td></tr>
    </table>`
}

function itemRows(m) {
  const c = m.currency
  const cols = m.anyHsn ? 7 : 6
  const body = m.rows.map((r) => `
    <tr>
      <td class="c">${r.sl}</td>
      <td class="desc"><b>${esc(r.name)}</b>${r.item_no ? `<span class="muted"> · ${esc(r.item_no)}</span>` : ''}</td>
      ${m.anyHsn ? `<td class="c">${esc(r.hsn)}</td>` : ''}
      <td class="r nowrap">${r.qty.toLocaleString('en-IN')} pcs</td>
      <td class="r">${fmt(r.rate, c)}</td>
      <td class="c">pcs</td>
      <td class="r">${fmt(r.amount, c)}</td>
    </tr>`).join('')

  const pad = `${m.anyHsn ? '<td></td>' : ''}<td></td><td></td><td></td>`
  const charge = (label, amount) => `
    <tr class="tax">
      <td></td><td class="desc r">${esc(label)}</td>
      ${pad}<td class="r">${fmt(amount, c)}</td>
    </tr>`

  // Everything the supplier added on top of goods, each on its own line.
  const half = m.cleanRate ? ` @ ${m.cleanRate / 2}%` : ''
  const charges = [
    m.postage > 0 ? charge('Add : Postage / Freight', m.postage) : '',
    m.cgst > 0 ? charge(`Add : INPUT CGST${half}`, m.cgst) : '',
    m.sgst > 0 ? charge(`Add : INPUT SGST${half}`, m.sgst) : '',
  ].join('')

  const totalQty = m.rows.reduce((s, r) => s + r.qty, 0)
  return `
    <table class="items">
      <thead>
        <tr>
          <th class="c">Sl</th><th>Description of Goods</th>
          ${m.anyHsn ? '<th class="c">HSN/SAC</th>' : ''}
          <th class="r">Quantity</th><th class="r">Rate</th><th class="c">per</th>
          <th class="r">Amount</th>
        </tr>
      </thead>
      <tbody>
        ${body}
        <tr class="tax">
          <td></td><td class="desc r"><b>Goods Total</b></td>
          ${pad}<td class="r"><b>${fmt(m.goods, c)}</b></td>
        </tr>
        ${charges}
        <tr class="spacer"><td colspan="${cols}"></td></tr>
      </tbody>
      <tfoot>
        <tr class="grand">
          <td></td><td class="r">Total</td>
          ${m.anyHsn ? '<td></td>' : ''}
          <td class="r nowrap">${totalQty.toLocaleString('en-IN')} pcs</td><td></td><td></td>
          <td class="r"><b>${fmt(m.grand, c)}</b></td>
        </tr>
      </tfoot>
    </table>`
}

// Tax summary. 036 records CGST/SGST as amounts on the whole bill, not per HSN,
// so this is one taxable-value row — honest about what was actually captured
// rather than inventing an HSN-wise split.
function taxSummary(m) {
  if (m.tax <= 0) return ''
  const c = m.currency
  const rate = m.cleanRate ? `${m.cleanRate / 2}%` : '—'
  return `
    <table class="hsn">
      <thead>
        <tr>
          <th rowspan="2">Taxable Value</th>
          <th colspan="2">INPUT CGST</th><th colspan="2">INPUT SGST/UTGST</th>
          <th rowspan="2" class="r">Total<br/>Tax Amount</th>
        </tr>
        <tr><th>Rate</th><th class="r">Amount</th><th>Rate</th><th class="r">Amount</th></tr>
      </thead>
      <tbody>
        <tr>
          <td class="r">${fmt(m.goods, c)}</td>
          <td class="c">${rate}</td><td class="r">${fmt(m.cgst, c)}</td>
          <td class="c">${rate}</td><td class="r">${fmt(m.sgst, c)}</td>
          <td class="r">${fmt(m.tax, c)}</td>
        </tr>
      </tbody>
    </table>`
}

export function purchaseBillHtml(model) {
  const m = model
  const s = m.shop
  const sup = m.supplier
  return `<!doctype html>
<html><head><meta charset="utf-8"/><title>Purchase Bill ${esc(m.number)}</title>
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

  .head { display: flex; }
  .head .seller { width: 56%; border: 1px solid #000; border-right: 0; padding: 4px 6px; }
  .head .meta-wrap { width: 44%; }
  .seller .nm { font-weight: 700; font-size: 8.5pt; }
  table.meta td { height: 13px; }
  .mk { display: block; font-size: 6pt; color: #333; }
  .mv { display: block; font-weight: 700; }

  .parties { display: flex; border: 1px solid #000; border-top: 0; }
  .parties > div { width: 56%; padding: 4px 6px; }
  .parties .ship { width: 44%; border-left: 1px solid #000; }
  .party-label { font-size: 6.5pt; color: #333; }
  .party-name { font-weight: 700; }

  table.items { border-top: 0; }
  table.items th { background: #f0f0f0; font-size: 6.5pt; }
  table.items td.desc { width: 46%; }
  tr.tax td { border-top: 0; border-bottom: 0; }
  tr.spacer td { height: 10px; border-top: 0; border-bottom: 0; }
  tr.grand td { font-weight: 700; border-top: 1px solid #000; }

  .words { border: 1px solid #000; border-top: 0; padding: 3px 6px; }
  .words b { font-size: 8pt; }
  table.hsn { border-top: 0; }
  table.hsn th { background: #f0f0f0; font-size: 6.5pt; }

  .foot { display: flex; border: 1px solid #000; border-top: 0; }
  .foot .decl { width: 60%; padding: 4px 6px; border-right: 1px solid #000; }
  .foot .sign { width: 40%; padding: 4px 6px; text-align: right; }
  .foot .sign .for { font-weight: 700; }
  .foot .sign .line { margin-top: 30px; font-size: 6.5pt; }
  .cgi { text-align: center; font-size: 6.5pt; margin-top: 3px; color: #333; }
</style></head>
<body><div class="doc">
  <div class="title">Purchase Bill</div>

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
    <div class="bill">
      <div class="party-label">Supplier (Bill from)</div>
      <div class="party-name">${esc(sup?.name || '—')}</div>
      ${sup?.contact_person ? `<div>Contact : ${esc(sup.contact_person)}</div>` : ''}
      ${sup?.phone ? `<div>Mob. : ${esc(sup.phone)}</div>` : ''}
      ${sup?.address ? `<div>${esc(sup.address)}</div>` : ''}
    </div>
    <div class="ship">
      <div class="party-label">Goods received at (Bill to)</div>
      <div class="party-name">${esc(s.name)}</div>
      ${s.address ? `<div>${esc(s.address)}</div>` : ''}
      ${s.gstin ? `<div>GSTIN/UIN : ${esc(s.gstin)}</div>` : ''}
      ${stateLine(s)}
    </div>
  </div>

  ${itemRows(m)}

  <div class="words">
    <div style="font-size:6.5pt;color:#333">Amount Payable to Supplier (in words)</div>
    <b>${esc(m.words)}</b>
  </div>

  ${taxSummary(m)}
  ${m.taxWords ? `<div class="words"><div style="font-size:6.5pt;color:#333">Input Tax Credit (in words)</div><b>${esc(m.taxWords)}</b></div>` : ''}
  ${m.notes ? `<div class="words"><div style="font-size:6.5pt;color:#333">Note</div>${esc(m.notes)}</div>` : ''}

  <div class="foot">
    <div class="decl">
      <div style="font-size:6.5pt;color:#333">For our records</div>
      <div>Goods taken into stock against this bill.${
        m.postage > 0 ? ' Postage is a bill expense and is not added to any item’s cost rate.' : ''
      }${
        m.tax > 0 ? ' GST shown above is claimable input credit and is not part of product cost.' : ''
      }</div>
    </div>
    <div class="sign">
      <div class="for">for ${esc(s.name)}</div>
      <div class="line">Received &amp; Verified</div>
    </div>
  </div>
  <div class="cgi">Shop's own record of a supplier bill — not a tax invoice. Computer generated.</div>
</div></body></html>`
}

// ---------------------------------------------------------------------------
// Print (→ Save as PDF) via a hidden iframe — no popup, same as the invoice.
// ---------------------------------------------------------------------------
export function printPurchaseBill(model) {
  const html = purchaseBillHtml(model)
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

// Open in a new tab for on-screen reading (no auto-print).
export function viewPurchaseBill(model) {
  const w = window.open('', '_blank')
  if (!w) { printPurchaseBill(model); return } // popup blocked → fall back to print
  w.document.open(); w.document.write(purchaseBillHtml(model)); w.document.close()
}
