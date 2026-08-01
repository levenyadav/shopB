import { Link } from 'react-router-dom'
import { IconReceipt2, IconChevronRight } from '@tabler/icons-react'
import { money, dateTime } from '../lib/format'
import { Badge } from './ui'

// Per-party ledger view (SPEC §6.10, §7.11). The ledger table is append-only and
// written only by triggers (Golden Rule #9) — this is a read-only render.
//
// The raw debit/credit columns mean opposite things for buyers vs suppliers, so
// instead of showing accounting columns we show a plain signed change to the
// party's running balance, which reads the same for everyone (SPEC §3 — simple on
// top). running_balance is the balance *after* the entry, straight from the row.
const ENTRY = {
  purchase:    { label: 'Purchase',     tone: 'peacock', sign: +1 },
  sale:        { label: 'Sale',         tone: 'saffron', sign: +1 },
  payment_in:  { label: 'Payment in',   tone: 'profit',  sign: -1 },
  payment_out: { label: 'Payment out',  tone: 'profit',  sign: -1 },
}

// Where an entry came from. Every ledger row carries reference_id +
// reference_table (001), so a purchase or a sale can open the document behind
// it. A purchase's reference_id is the bill's FIRST purchases line (033) —
// exactly what /owner/purchases/:id expects. Payments have no detail page yet,
// so those rows stay plain text rather than pretending to be clickable.
function detailPath(e) {
  if (!e.reference_id) return null
  if (e.entry_type === 'purchase') return `/owner/purchases/${e.reference_id}`
  if (e.entry_type === 'sale') return `/owner/sales/${e.reference_id}`
  return null
}

export default function LedgerTable({ entries, currency = '₹' }) {
  if (!entries?.length) {
    return (
      <div className="grid place-items-center gap-3 rounded-lg border border-dashed border-line py-14 text-center text-muted">
        <IconReceipt2 size={36} stroke={1.3} />
        <p>No ledger entries yet for this party.</p>
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-card">
      {/* header — hidden on phones, the cards carry their own labels there */}
      <div className="hidden grid-cols-[1fr_auto_auto] gap-4 border-b border-line bg-paper-2 px-5 py-2.5 text-xs font-semibold uppercase tracking-wider text-muted sm:grid">
        <span>Entry</span>
        <span className="text-right">Change</span>
        <span className="text-right">Balance after</span>
      </div>

      <ul className="divide-y divide-line">
        {entries.map((e) => {
          const meta = ENTRY[e.entry_type] || { label: e.entry_type, tone: 'muted', sign: +1 }
          const amount = Number(e.debit || 0) + Number(e.credit || 0)
          const up = meta.sign > 0
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
                {to && <span className="ml-2 text-peacock">{e.entry_type === 'sale' ? 'View sale' : 'View bill'}</span>}
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
                <span className="sm:hidden mr-1 text-xs text-muted">Change</span>
                <span className={`fig font-semibold ${up ? 'text-dues' : 'text-profit'}`}>
                  {up ? '+' : '−'}{money(amount).replace('₹', currency)}
                </span>
              </div>

              <div className="col-span-2 text-right sm:col-span-1">
                <span className="sm:hidden mr-1 text-xs text-muted">Balance after</span>
                <span className="fig text-ink">{money(e.running_balance).replace('₹', currency)}</span>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
