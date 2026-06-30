import { money } from '../lib/format'

// Running balance card for a party (SPEC §6.7, §17). One labelled figure — never
// a bare number (SPEC §3.3). Buyers owe the shop (udhaar); the shop owes
// suppliers (dues). Both live in `balance_due`; only the wording differs.
//
// settled = balance is zero (nothing outstanding either way).
export default function PartyBalance({ partyType, balance, currency = '₹' }) {
  const value = Number(balance || 0)
  const isSupplier = partyType === 'supplier'
  const settled = value <= 0

  const label = settled
    ? 'All settled'
    : isSupplier
      ? 'We owe this supplier'
      : 'Udhaar owed to shop'

  return (
    <div
      className={`rounded-lg border p-5 ${
        settled
          ? 'border-profit/30 bg-profit/10'
          : 'border-dues/30 bg-dues/10'
      }`}
    >
      <p className="text-sm text-muted">{label}</p>
      <p className={`fig mt-1 text-3xl font-bold ${settled ? 'text-profit' : 'text-dues'}`}>
        {money(settled ? 0 : value).replace('₹', currency)}
      </p>
      {!settled && (
        <p className="mt-1 text-xs text-muted">
          {isSupplier
            ? 'Clear this with a Payment Out entry.'
            : 'Clear this with a Payment In entry.'}
        </p>
      )}
    </div>
  )
}
