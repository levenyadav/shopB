import { Link } from 'react-router-dom'
import { IconReceipt2, IconChevronRight } from '@tabler/icons-react'
import { money, dateTime } from '../lib/format'
import { Badge } from './ui'

// Per-party ledger (SPEC §6.10, §7.11). The ledger is append-only and written
// only by triggers (Golden Rule #9) — this is a read-only render.
//
// Rows come from the `ledger_entries` view (migration 052), NOT the raw table,
// because two things cannot be read correctly off the raw columns:
//
//   * debit/credit mean opposite things for buyers and suppliers, and the two
//     adjustment rows flip again within their own side — a counter-sale
//     discount is a DEBIT on a 'sale' entry (051), purchase bill charges are a
//     DEBIT on a 'purchase' entry (036). Signing by entry_type showed a ₹5,200
//     discount as "+₹5,200", wrong by double. `signed_amount` is signed once,
//     correctly, in SQL.
//
//   * a ledger row does not mean the balance moved. Every sale writes a row,
//     but only udhaar touches balance_due — so a cash bill used to read
//     "+₹4,500" beside a "Balance after" that hadn't budged. `moved_balance`
//     separates the two, and those rows now say so in plain words instead of
//     showing a change that never happened.
const KIND = {
  purchase:      { label: 'Purchase',    tone: 'peacock' },
  sale:          { label: 'Sale',        tone: 'saffron' },
  sale_discount: { label: 'Discount',    tone: 'profit'  },
  payment_in:    { label: 'Payment in',  tone: 'profit'  },
  payment_out:   { label: 'Payment out', tone: 'profit'  },
}

// Where an entry came from. Every ledger row carries reference_id +
// reference_table (001), so a purchase or a sale can open the document behind
// it. A purchase's reference_id is the bill's FIRST purchases line (033) —
// exactly what /owner/purchases/:id expects. Payments have no detail page yet,
// so those rows stay plain text rather than pretending to be clickable.
function detailPath(e) {
  if (!e.reference_id) return null
  if (e.reference_table === 'purchases') return `/owner/purchases/${e.reference_id}`
  if (e.reference_table === 'sales') return `/owner/sales/${e.reference_id}`
  return null
}

export default function LedgerTable({ entries, currency = '₹', emptyText }) {
  if (!entries?.length) {
    return (
      <div className="grid place-items-center gap-3 rounded-lg border border-dashed border-line py-14 text-center text-muted">
        <IconReceipt2 size={36} stroke={1.3} />
        <p>{emptyText || 'No ledger entries yet for this party.'}</p>
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-card">
      {/* header — hidden on phones, the cards carry their own labels there */}
      <div className="hidden grid-cols-[1fr_auto_auto] gap-4 border-b border-line bg-paper-2 px-5 py-2.5 text-xs font-semibold uppercase tracking-wider text-muted sm:grid">
        <span>Entry</span>
        <span className="text-right">Amount</span>
        <span className="text-right">Balance after</span>
      </div>

      <ul className="divide-y divide-line">
        {entries.map((e) => {
          const meta = KIND[e.kind] || { label: e.kind, tone: 'muted' }
          const signed = Number(e.signed_amount || 0)
          const owesMore = signed > 0
          const moved = e.moved_balance !== false
          const to = detailPath(e)
          const entry = (
            <>
              <div className="flex items-center gap-2">
                <Badge tone={meta.tone}>{meta.label}</Badge>
                <span className="truncate text-ink">{e.description}</span>
                {to && <IconChevronRight size={15} className="shrink-0 text-muted" />}
              </div>
              <p className="mt-0.5 text-xs text-muted">
                {dateTime(e.created_at)}
                {e.invoice_no && <span className="fig ml-2">Bill {e.invoice_no}</span>}
                {e.payment_reference_no && <span className="fig ml-2">Ref {e.payment_reference_no}</span>}
                {to && <span className="ml-2 text-peacock">{e.reference_table === 'sales' ? 'View sale' : 'View bill'}</span>}
              </p>
            </>
          )
          return (
            <li key={e.id} className={`grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 px-5 py-3 text-sm sm:grid-cols-[1fr_auto_auto] ${to ? 'transition hover:bg-paper-2' : ''}`}>
              {to ? (
                <Link to={to} className="min-w-0">{entry}</Link>
              ) : (
                <div className="min-w-0">{entry}</div>
              )}

              <div className="text-right">
                <span className="sm:hidden mr-1 text-xs text-muted">Amount</span>
                <span className={`fig font-semibold ${
                  !moved ? 'text-muted' : owesMore ? 'text-dues' : 'text-profit'
                }`}>
                  {moved ? (owesMore ? '+' : '−') : ''}{money(Math.abs(signed)).replace('₹', currency)}
                </span>
              </div>

              <div className="col-span-2 text-right sm:col-span-1">
                {moved ? (
                  <>
                    <span className="sm:hidden mr-1 text-xs text-muted">Balance after</span>
                    <span className="fig text-ink">{money(e.running_balance).replace('₹', currency)}</span>
                  </>
                ) : (
                  // Settled at the counter — it never joined the account, so
                  // showing a "balance after" here would imply it did.
                  <span className="text-xs text-muted">
                    Paid {e.sale_payment_type === 'upi' ? 'by UPI' : 'in cash'} · nothing on account
                  </span>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
