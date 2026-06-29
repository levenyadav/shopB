import { money, qty, dateTime } from '../lib/format'

// SPEC §13.1 — Order Supply Slip. Printed by the owner on approval and handed to
// staff for packing. Hidden on screen (.print-slip); the browser's native print
// shows only this block (see @media print in index.css). Figures are the buyer-
// facing rate/amount only — never cost or profit (Golden Rule #4).
const PAYMENT_LABEL = { cash: 'Cash', upi: 'UPI', udhaar: 'Udhaar (credit)' }

export default function SupplySlip({ job, shop }) {
  if (!job) return null
  const currency = shop?.currency_symbol || '₹'
  const ref = job.order_id?.slice(0, 8).toUpperCase()

  return (
    <div className="print-slip">
      <div className="mx-auto max-w-md text-[13px] leading-relaxed">
        {/* Header — shop identity */}
        <div className="text-center">
          <p className="text-lg font-bold">{shop?.name || 'Shop'}</p>
          {shop?.phone && <p className="fig">{shop.phone}</p>}
          {shop?.address && <p>{shop.address}</p>}
        </div>

        <p className="my-2 text-center font-semibold tracking-wide">— ORDER SUPPLY SLIP —</p>

        <Line label="Slip printed" value={dateTime(new Date().toISOString())} />
        <Line label="Order placed" value={dateTime(job.ordered_at)} />
        <Line label="Order ref" value={<span className="fig">#{ref}</span>} />

        <Hr />

        <Line label="Buyer" value={`${job.buyer_name || '—'} (${job.buyer_type || '—'})`} />
        <Line label="Phone" value={<span className="fig">{job.buyer_phone || '—'}</span>} />

        <Hr />

        <Line label="Item" value={job.item_name} />
        <Line label="Item No" value={<span className="fig">{job.item_no || '—'}</span>} />
        <Line label="Location / Rack" value={job.location || '—'} />

        <Hr />

        <Line label="Quantity" value={<span className="fig">{qty(job.quantity)} pcs</span>} />
        <Line label="Rate (each)" value={<span className="fig">{money(job.rate_at_order).replace('₹', currency)}</span>} />
        <Line label="Total amount" value={<span className="fig font-bold">{money(job.amount).replace('₹', currency)}</span>} />
        <Line label="Payment" value={PAYMENT_LABEL[job.payment_type] || '—'} />

        {job.notes && (
          <>
            <Hr />
            <p className="text-xs">Buyer note: {job.notes}</p>
          </>
        )}

        <Hr />

        {/* Signature space */}
        <div className="mt-8 flex justify-between text-xs">
          <div>
            <div className="mb-1 w-40 border-t border-black" />
            Packed by (sign)
          </div>
          <div className="text-right">
            <div className="mb-1 w-40 border-t border-black" />
            Received by (sign)
          </div>
        </div>
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
