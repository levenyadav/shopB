import { money, qty, dateTime } from '../lib/format'

// Counter-sale receipt for a walk-in bill (POS). Multi-item, grouped by bill_id.
// Hidden on screen (.print-slip); the browser's native print shows only this
// block (see @media print in index.css). Buyer-facing figures only — never cost
// or profit (Golden Rule #4).
const PAYMENT_LABEL = { cash: 'Cash', upi: 'UPI', udhaar: 'Udhaar (credit)' }

export default function CounterReceipt({ bill, shop }) {
  if (!bill) return null
  const currency = shop?.currency_symbol || '₹'
  const ref = bill.bill_id?.slice(0, 8).toUpperCase()
  const m = (n) => money(n).replace('₹', currency)

  return (
    <div className="print-slip">
      <div className="mx-auto max-w-md text-[13px] leading-relaxed">
        {/* Header — shop identity */}
        <div className="text-center">
          <p className="text-lg font-bold">{shop?.name || 'Shop'}</p>
          {shop?.phone && <p className="fig">{shop.phone}</p>}
          {shop?.address && <p>{shop.address}</p>}
        </div>

        <p className="my-2 text-center font-semibold tracking-wide">— CASH MEMO —</p>

        <Line label="Date" value={dateTime(bill.created_at)} />
        <Line label="Bill no" value={<span className="fig">#{ref}</span>} />
        <Line label="Buyer" value={`${bill.buyer_name || 'Walk-in'} (${bill.buyer_type || 'customer'})`} />
        {bill.buyer_phone && <Line label="Phone" value={<span className="fig">{bill.buyer_phone}</span>} />}

        <Hr />

        {/* Line items */}
        <div className="flex justify-between gap-2 pb-1 text-[11px] font-semibold uppercase text-muted">
          <span className="flex-1">Item</span>
          <span className="w-10 text-right">Qty</span>
          <span className="w-16 text-right">Rate</span>
          <span className="w-20 text-right">Amount</span>
        </div>
        {bill.lines.map((l, i) => (
          <div key={i} className="flex justify-between gap-2 py-0.5">
            <span className="flex-1">
              {l.item_name}
              {l.item_no && <span className="fig text-muted"> · {l.item_no}</span>}
            </span>
            <span className="w-10 text-right fig">{qty(l.quantity)}</span>
            <span className="w-16 text-right fig">{m(l.rate)}</span>
            <span className="w-20 text-right fig">{m(l.amount)}</span>
          </div>
        ))}

        <Hr />

        <Line
          label={`Items (${bill.lines.length})`}
          value={<span className="fig">{qty(bill.lines.reduce((s, l) => s + Number(l.quantity || 0), 0))} pcs</span>}
        />
        <Line label="Total amount" value={<span className="fig text-base font-bold">{m(bill.total)}</span>} />
        <Line label="Payment" value={PAYMENT_LABEL[bill.payment_type] || '—'} />
        {bill.payment_type === 'cash' && bill.tendered != null && (
          <>
            <Line label="Cash given" value={<span className="fig">{m(bill.tendered)}</span>} />
            <Line label="Change" value={<span className="fig">{m(Math.max(0, bill.tendered - bill.total))}</span>} />
          </>
        )}
        {bill.payment_type === 'udhaar' && (
          <p className="mt-1 text-xs">Added to {bill.buyer_name || 'buyer'}'s udhaar (credit) balance.</p>
        )}

        <Hr />

        <p className="text-center text-xs">{shop?.brand_text || 'Thank you — please visit again'}</p>
      </div>
    </div>
  )
}

function Line({ label, value }) {
  return (
    <div className="flex justify-between gap-4 py-0.5">
      <span className="text-muted">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  )
}

function Hr() {
  return <div className="my-2 border-t border-dashed border-black/40" />
}
