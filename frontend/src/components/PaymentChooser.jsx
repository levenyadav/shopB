import { money } from '../lib/format'
import { round2 } from '../lib/helpers'
import { Field } from './ui'

// How the buyer is paying for a bill — shared by Counter Sale and shopfront
// approval (migration 056).
//
//   Cash / UPI          — the whole bill is paid now.
//   Udhaar / part paid  — "Paid now" (0 up to the bill) is taken by cash or UPI
//                         and the rest goes on the buyer's account.
//
// Every bill goes on the account and money taken now is a receipt against it,
// so an advance the buyer already holds (a negative balance) is used up by
// an udhaar bill by itself. This panel shows that before the bill is saved.
export const PAYMENTS = [['cash', 'Cash'], ['upi', 'UPI'], ['udhaar', 'Udhaar / part paid']]

// What the RPC will be sent, and the one thing that blocks saving.
export function paymentArgs({ payment, paidNow, paidMethod, total }) {
  const raw = round2(Math.max(0, Number(paidNow) || 0))
  const error = payment === 'udhaar' && raw > total
    ? 'More than the bill. Take the extra as a Payment In advance instead.'
    : ''
  const paid = payment === 'udhaar' ? Math.min(raw, total) : total
  return {
    error,
    paid,
    onAccount: round2(total - paid),
    rpc: payment === 'udhaar' ? { p_paid_now: paid, p_paid_method: paidMethod } : {},
  }
}

export default function PaymentChooser({
  payment, setPayment, paidNow, setPaidNow, paidMethod, setPaidMethod,
  total, balance = 0, buyerName, currency = '₹', question = 'Payment',
}) {
  const m = (n) => money(n).replace('₹', currency)
  const bal = Number(balance) || 0
  const advance = bal < 0 ? -bal : 0
  const { error, paid, onAccount } = paymentArgs({ payment, paidNow, paidMethod, total })
  const after = round2(bal + onAccount)
  const who = buyerName || 'The buyer'

  return (
    <div>
      <p className="mb-1.5 text-sm font-medium">{question}</p>

      {advance > 0 && (
        <p className="mb-2 rounded-lg bg-peacock/10 px-3 py-2 text-xs text-peacock">
          {who} has an advance of <b className="fig">{m(advance)}</b> with the shop.{' '}
          {payment === 'udhaar'
            ? 'It is used against this bill.'
            : 'Choose "Udhaar / part paid" to use it against this bill.'}
        </p>
      )}

      <div className="grid grid-cols-3 gap-2">
        {PAYMENTS.map(([key, label]) => (
          <button
            key={key} type="button" onClick={() => setPayment(key)}
            className={`rounded-lg border px-2 py-2 text-sm font-medium transition ${
              payment === key ? 'border-peacock bg-peacock/10 text-peacock' : 'border-line bg-card text-muted hover:text-ink'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {payment === 'udhaar' && (
        <div className="mt-3 space-y-2">
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Field
                label="Paid now (leave empty if nothing)" prefix={currency}
                inputMode="decimal" type="number" min={0} step="1" placeholder="0"
                value={paidNow} onChange={(e) => setPaidNow(e.target.value)}
                error={error || undefined}
              />
            </div>
            {paid > 0 && (
              <div className="mb-0.5 flex overflow-hidden rounded-md border border-line text-sm">
                {[['cash', 'Cash'], ['upi', 'UPI']].map(([k, l]) => (
                  <button
                    key={k} type="button" onClick={() => setPaidMethod(k)}
                    className={`px-3 py-2.5 font-medium ${paidMethod === k ? 'bg-peacock text-white' : 'bg-card text-muted hover:text-ink'}`}
                  >
                    {l}
                  </button>
                ))}
              </div>
            )}
          </div>

          <dl className="space-y-1 rounded-lg bg-paper-2 px-3 py-2 text-xs">
            <Line label="Bill total" value={m(total)} />
            {paid > 0 && <Line label={`Paid now (${paidMethod === 'upi' ? 'UPI' : 'cash'})`} value={`− ${m(paid)}`} />}
            <Line label="Goes on account" value={m(onAccount)} strong />
            <Line
              label={`${who}'s balance after this bill`}
              value={after > 0 ? `Udhaar ${m(after)}` : after < 0 ? `Advance left ${m(-after)}` : 'All settled'}
              tone={after > 0 ? 'text-dues' : after < 0 ? 'text-peacock' : 'text-profit'}
              strong
            />
          </dl>
        </div>
      )}
    </div>
  )
}

function Line({ label, value, strong, tone = 'text-ink' }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className={`fig ${strong ? 'font-semibold' : ''} ${tone}`}>{value}</dd>
    </div>
  )
}
