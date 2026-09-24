// A4 Statement of Account for one party (customer / dealer / supplier).
//
// Rendered as a self-contained HTML document and printed through a hidden
// iframe — the same no-popup pattern as invoiceTemplate.js and barcodeLabel.js,
// so "Download" is the browser's native Print → Save as PDF with no PDF library.
//
// WHAT BELONGS ON A STATEMENT. Only entries that moved the account. A cash or
// UPI bill is settled at the counter and never touches balance_due (see
// on_sale_insert / migration 052's `moved_balance`), so it is not an account
// transaction and printing it would stop the statement footing:
//     opening + billed - settled = closing
// holds exactly because those rows are excluded. The on-screen Ledger still
// shows every entry; this document is the money-owed record.
//
// SIDES. Proper double entry, per side, with a plain-words legend underneath:
//   buyer (debtor)    — a sale DEBITS them, a receipt CREDITS them
//   supplier (creditor) — their bill CREDITS them, our payment DEBITS them
// Either way the Balance column is "what is owed", and migration 052's
// signed_amount is positive whenever the party owes more, so one mapping serves
// both: positive -> the owed side, negative -> the settling side.
//
// Golden Rule #4: nothing here is derived from purchase_rate or profit.

import { round2 } from './helpers'
import { amountInWords } from './invoiceTemplate'

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}

function fmt(n, currency) {
  const v = Number(n || 0)
  if (!v) return '—'
  return currency + v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function day(d) {
  if (!d) return ''
  return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

function stateLine(p) {
  if (!p?.state_name && !p?.state_code) return ''
  const name = p.state_name ? esc(p.state_name) : ''
  const code = p.state_code ? `, Code : ${esc(p.state_code)}` : ''
  return `<div>State Name&nbsp;: ${name}${code}</div>`
}

// ---------------------------------------------------------------------------
// Build the render model from ledger_entries rows (migration 052).
//
// `entries` must be ASCENDING by date and already limited to the period. The
// opening balance is what the account stood at before the first row shown —
// the caller passes it, computed as closing minus the period's movement, so a
// filtered period still foots.
// ---------------------------------------------------------------------------
export function buildStatementModel({
  shop, party, entries, openingBalance = 0, from = null, to = null,
  openBills = [], currency = '₹',
}) {
  const isSupplier = party.party_type === 'supplier'

  // Account rows only. balance_delta is 0 for a counter-settled bill.
  const account = (entries || []).filter((e) => Number(e.balance_delta || 0) !== 0)

  let running = round2(openingBalance)
  let billed = 0
  let settled = 0

  const rows = account.map((e) => {
    const delta = round2(e.balance_delta)
    running = round2(running + delta)
    if (delta > 0) billed = round2(billed + delta)
    else settled = round2(settled - delta)
    return {
      date: day(e.created_at),
      particulars: e.description || e.kind,
      ref: e.invoice_no || '',
      method: e.payment_method || '',
      refNo: e.payment_reference_no || '',
      // Positive = the party owes more. For a buyer that is the debit column;
      // for a supplier it is the credit column.
      owed: delta > 0 ? delta : 0,
      settled: delta < 0 ? -delta : 0,
      balance: running,
    }
  })

  const ageing = ['0-30', '31-60', '61-90', '90+'].map((bucket) => ({
    bucket,
    amount: round2((openBills || [])
      .filter((b) => b.age_bucket === bucket)
      .reduce((s, b) => s + Number(b.outstanding || 0), 0)),
  }))

  return {
    currency,
    isSupplier,
    seller: {
      name: shop?.legal_name || shop?.name || 'Our Shop',
      address: shop?.address, phone: shop?.phone, gstin: shop?.gstin,
      email: shop?.email, pan: shop?.pan,
      state_name: shop?.state_name, state_code: shop?.state_code,
      bank: shop?.bank_details,
    },
    party: {
      name: party.name || 'Unnamed',
      type: party.party_type,
      phone: party.phone, gstin: party.gstin, address: party.address,
      state_name: party.state_name, state_code: party.state_code,
      contact_person: party.contact_person,
    },
    period: {
      from: from ? day(from) : null,
      to: day(to || new Date()),
      allTime: !from,
    },
    rows,
    openingBalance: round2(openingBalance),
    billed,
    settled,
    closingBalance: running,
    ageing,
    hasAgeing: ageing.some((a) => a.amount > 0),
    printedAt: new Date().toLocaleString('en-IN', {
      day: 'numeric', month: 'short', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    }),
  }
}

// ---------------------------------------------------------------------------
// HTML.
// ---------------------------------------------------------------------------
function partyBlock(m) {
  const p = m.party
  return `
    <div class="party-label">Statement for</div>
    <div class="party-name">${esc(p.name)}</div>
    <div class="muted" style="text-transform:capitalize">${esc(p.type)}</div>
    ${p.contact_person ? `<div>Contact : ${esc(p.contact_person)}</div>` : ''}
    ${p.address ? `<div>${esc(p.address)}</div>` : ''}
    ${p.phone ? `<div>Mob. : ${esc(p.phone)}</div>` : ''}
    ${p.gstin ? `<div>GSTIN/UIN : ${esc(p.gstin)}</div>` : ''}
    ${stateLine(p)}`
}

function tableRows(m) {
  const c = m.currency
  if (!m.rows.length) {
    return `<tr><td colspan="5" class="c muted" style="padding:14px">
      No account transactions in this period.
    </td></tr>`
  }
  return m.rows.map((r) => `
    <tr>
      <td class="nowrap">${esc(r.date)}</td>
      <td class="desc">${esc(r.particulars)}${
        r.refNo ? `<span class="muted"> · Ref ${esc(r.refNo)}</span>` : ''
      }</td>
      <td class="c nowrap">${esc(r.ref)}</td>
      <td class="r nowrap">${r.owed ? fmt(r.owed, c) : ''}</td>
      <td class="r nowrap">${r.settled ? fmt(r.settled, c) : ''}</td>
      <td class="r nowrap"><b>${fmt(r.balance, c)}</b></td>
    </tr>`).join('')
}

function ageingTable(m) {
  if (!m.hasAgeing) return ''
  const c = m.currency
  const cells = m.ageing.map((a) => `<th class="c">${a.bucket === '90+' ? 'Over 90' : a.bucket} days</th>`).join('')
  const vals = m.ageing.map((a) => `<td class="r">${fmt(a.amount, c)}</td>`).join('')
  return `
    <div class="sec">How old is the outstanding</div>
    <table class="ageing">
      <thead><tr>${cells}</tr></thead>
      <tbody><tr>${vals}</tr></tbody>
    </table>
    <div class="legend">Oldest bills are treated as paid first, so each bucket is the part of the
      balance that has been outstanding for that long.</div>`
}

export function statementHtml(model) {
  const m = model
  const s = m.seller
  const c = m.currency
  // Column headings follow the party's side of the books.
  const owedHead = m.isSupplier ? 'Credit (they billed)' : 'Debit (billed)'
  const settledHead = m.isSupplier ? 'Debit (we paid)' : 'Credit (received)'
  const closingLabel = m.closingBalance < 0
    ? (m.isSupplier ? 'Advance with this supplier' : 'Advance held from this party')
    : m.isSupplier ? 'Balance we owe' : 'Balance owed to us'
  const closing = Math.abs(m.closingBalance)

  return `<!doctype html>
<html><head><meta charset="utf-8"/><title>Statement — ${esc(m.party.name)}</title>
<style>
  @page { size: A4 portrait; margin: 10mm; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  html, body { margin: 0; padding: 0; }
  body { font-family: Arial, Helvetica, sans-serif; color: #000; font-size: 8.5pt; line-height: 1.3; }
  .doc { width: 190mm; margin: 0 auto; }
  .title { text-align: center; font-weight: 700; font-size: 12pt; letter-spacing: .04em; }
  .sub { text-align: center; font-size: 7.5pt; color: #333; margin-bottom: 4px; }
  table { border-collapse: collapse; width: 100%; }
  td, th { border: 1px solid #000; padding: 3px 5px; vertical-align: top; }
  .r { text-align: right; } .c { text-align: center; } .nowrap { white-space: nowrap; }
  .muted { color: #444; font-weight: 400; }

  .head { display: flex; }
  .head .seller { width: 55%; border: 1px solid #000; border-right: 0; padding: 5px 7px; }
  .head .party  { width: 45%; border: 1px solid #000; padding: 5px 7px; }
  .seller .nm { font-weight: 700; font-size: 9.5pt; }
  .party-label { font-size: 7pt; color: #333; }
  .party-name { font-weight: 700; font-size: 9.5pt; }

  .period { border: 1px solid #000; border-top: 0; padding: 4px 7px;
            display: flex; justify-content: space-between; }

  table.entries { border-top: 0; }
  table.entries th { background: #f0f0f0; font-size: 7pt; }
  table.entries td.desc { width: 44%; }
  tr.open td, tr.total td { font-weight: 700; background: #fafafa; }
  tr.total td { border-top: 1px solid #000; }

  .closing { border: 1px solid #000; border-top: 0; padding: 6px 7px;
             display: flex; justify-content: space-between; align-items: center; }
  .closing .lab { font-size: 7.5pt; color: #333; }
  .closing .val { font-size: 12pt; font-weight: 700; }

  .sec { margin-top: 8px; font-size: 7pt; color: #333; text-transform: uppercase; letter-spacing: .06em; }
  table.ageing th { background: #f0f0f0; font-size: 7pt; }
  .legend { font-size: 7pt; color: #333; margin-top: 3px; }
  .words { border: 1px solid #000; border-top: 0; padding: 4px 7px; }

  .foot { display: flex; margin-top: 10px; }
  .foot .note { width: 62%; padding-right: 10px; font-size: 7.5pt; }
  .foot .sign { width: 38%; text-align: right; }
  .foot .sign .for { font-weight: 700; }
  .foot .sign .line { margin-top: 34px; font-size: 7pt; border-top: 1px solid #000; display: inline-block; padding-top: 2px; }
  .cgi { text-align: center; font-size: 7pt; margin-top: 6px; color: #333; }
</style></head>
<body><div class="doc">
  <div class="title">Statement of Account</div>
  <div class="sub">Printed ${esc(m.printedAt)}</div>

  <div class="head">
    <div class="seller">
      <div class="nm">${esc(s.name)}</div>
      ${s.address ? `<div>${esc(s.address)}</div>` : ''}
      ${s.phone ? `<div>Mob. : ${esc(s.phone)}</div>` : ''}
      ${s.gstin ? `<div>GSTIN/UIN : ${esc(s.gstin)}</div>` : ''}
      ${stateLine(s)}
      ${s.email ? `<div>E-Mail : ${esc(s.email)}</div>` : ''}
    </div>
    <div class="party">${partyBlock(m)}</div>
  </div>

  <div class="period">
    <div><span class="muted">Period&nbsp;:</span> <b>${
      m.period.allTime ? 'Since the account opened' : `${esc(m.period.from)} to ${esc(m.period.to)}`
    }</b></div>
    <div><span class="muted">Currency&nbsp;:</span> <b>${esc(c)}</b></div>
  </div>

  <table class="entries">
    <thead>
      <tr>
        <th class="nowrap" style="width:16%">Date</th>
        <th>Particulars</th>
        <th class="c" style="width:12%">Bill No.</th>
        <th class="r nowrap" style="width:14%">${esc(owedHead)}</th>
        <th class="r nowrap" style="width:14%">${esc(settledHead)}</th>
        <th class="r nowrap" style="width:15%">Balance</th>
      </tr>
    </thead>
    <tbody>
      <tr class="open">
        <td class="nowrap">${esc(m.period.allTime ? '' : m.period.from)}</td>
        <td class="desc">Opening balance</td>
        <td></td><td></td><td></td>
        <td class="r">${fmt(m.openingBalance, c)}</td>
      </tr>
      ${tableRows(m)}
    </tbody>
    <tfoot>
      <tr class="total">
        <td></td><td class="desc r">Total for the period</td><td></td>
        <td class="r">${fmt(m.billed, c)}</td>
        <td class="r">${fmt(m.settled, c)}</td>
        <td class="r">${fmt(m.closingBalance, c)}</td>
      </tr>
    </tfoot>
  </table>

  <div class="closing">
    <div>
      <div class="lab">${esc(closingLabel)} as on ${esc(m.period.to)}</div>
      <div class="muted" style="font-size:7pt">${esc(amountInWords(closing, c === '₹' ? 'INR' : c))}</div>
    </div>
    <div class="val">${fmt(closing, c)}</div>
  </div>

  ${ageingTable(m)}

  <div class="foot">
    <div class="note">
      <div><b>Please note.</b> Bills settled in cash or UPI at the counter are not account
      transactions and do not appear above. This statement covers money on account only.</div>
      ${s.bank ? `<div style="margin-top:4px">${esc(s.bank)}</div>` : ''}
      <div style="margin-top:4px">Errors and omissions excepted. Kindly report any difference within 7 days.</div>
    </div>
    <div class="sign">
      <div class="for">for ${esc(s.name)}</div>
      <div class="line">Authorised Signatory</div>
    </div>
  </div>
  <div class="cgi">This is a computer generated statement</div>
</div></body></html>`
}

// ---------------------------------------------------------------------------
// Print (→ Save as PDF) through a hidden iframe; and open-in-tab for a look
// first. Mirrors invoiceTemplate.js exactly.
// ---------------------------------------------------------------------------
export function printStatement(model) {
  const html = statementHtml(model)
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

export function viewStatement(model) {
  const w = window.open('', '_blank')
  if (!w) { printStatement(model); return }  // popup blocked → straight to print
  w.document.open(); w.document.write(statementHtml(model)); w.document.close()
}
