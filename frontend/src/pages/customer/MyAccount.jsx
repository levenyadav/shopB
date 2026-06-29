import { Link } from 'react-router-dom'
import { IconReceipt2, IconWallet } from '@tabler/icons-react'
import { useAuth } from '../../context/AuthContext'
import { useShop } from '../../context/ShopContext'
import { money } from '../../lib/format'

// SPEC §10.2 — buyer's profile + running balance (udhaar). Balance is maintained
// by triggers (sale on udhaar raises it; Payment In clears it) — read-only here.
export default function MyAccount() {
  const { profile, role } = useAuth()
  const { currency } = useShop()
  const due = Number(profile?.balance_due || 0)

  return (
    <div className="mx-auto max-w-xl space-y-5">
      <div>
        <h1 className="font-[var(--font-display)] text-3xl font-bold">My account</h1>
        <p className="text-muted">Your details and running balance with the shop.</p>
      </div>

      <div className="rounded-2xl border border-line bg-card p-5">
        <dl className="grid grid-cols-2 gap-4 text-sm">
          <Row label="Name" value={profile?.full_name || '—'} />
          <Row label="Phone" value={profile?.phone || '—'} />
          <Row label="Account type" value={<span className="capitalize">{role}</span>} />
        </dl>
      </div>

      <div className={`rounded-2xl border p-5 ${due > 0 ? 'border-dues/30 bg-dues/10' : 'border-profit/30 bg-profit/10'}`}>
        <div className="flex items-center gap-2 text-muted">
          <IconWallet size={18} />
          <p className="text-sm font-medium">Udhaar (running balance)</p>
        </div>
        <p className={`fig mt-1 text-3xl font-bold ${due > 0 ? 'text-dues' : 'text-profit'}`}>
          {money(due).replace('₹', currency)}
        </p>
        <p className="mt-1 text-sm text-ink/70">
          {due > 0
            ? 'This is what you owe the shop. Clear it at the counter — the shop records each payment.'
            : 'You have no outstanding balance. All clear.'}
        </p>
      </div>

      <Link
        to="/orders"
        className="inline-flex items-center gap-2 rounded-lg border border-line bg-card px-4 py-2.5 text-sm font-semibold hover:bg-paper-2"
      >
        <IconReceipt2 size={18} /> View my orders
      </Link>
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
