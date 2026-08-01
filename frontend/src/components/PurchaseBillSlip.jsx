import { money, qty, dateShort, dateTime } from '../lib/format'

// SPEC §13 — Purchase Bill record sheet. Same mechanism as the Order Supply
// Slip: it lives hidden in the page (.print-slip) and is the only thing the
// browser inks on window.print(), so there is no second component tree to keep
// in sync with the screen.
//
// This is the shop's OWN copy of a supplier bill — filed against the supplier's
// paper bill — so unlike a customer invoice it may show purchase rates. It is
// never shown to a buyer (Golden Rule #4).
export default function PurchaseBillSlip({ bill, shop }) {
  if (!bill) return null
  const currency = shop?.currency_symbol || '₹'
  const c = (n) => money(n).replace('₹', currency)

  return (
    <div className="print-slip">
      <div className="mx-auto max-w-lg text-[13px] leading-relaxed">
        {/* Header — our shop, the one filing this bill */}
        <div className="text-center">
          <p className="text-lg font-bold">{shop?.name || 'Shop'}</p>
          {shop?.phone && <p className="fig">{shop.phone}</p>}
          {shop?.address && <p>{shop.address}</p>}
        </div>

        <p className="my-2 text-center font-semibold tracking-wide">— PURCHASE BILL —</p>

        <Line label="Bill no." value={<span className="fig">{bill.invoice_no || '—'}</span>} />
        <Line label="Bill date" value={bill.invoice_date ? dateShort(bill.invoice_date) : dateShort(bill.createdAt)} />
        <Line label="Entered" value={dateTime(bill.createdAt)} />
        {bill.enteredBy && <Line label="Entered by" value={bill.enteredBy} />}

        <Hr />

        <Line label="Supplier" value={bill.supplier?.name || '—'} />
        {bill.supplier?.contact_person && <Line label="Contact" value={bill.supplier.contact_person} />}
        {bill.supplier?.phone && <Line label="Phone" value={<span className="fig">{bill.supplier.phone}</span>} />}
        {bill.supplier?.address && <Line label="Address" value={bill.supplier.address} />}

        <Hr />

        {/* Item lines */}
        <table className="w-full text-left text-[12px]">
          <thead>
            <tr className="border-b border-black">
              <th className="py-1 pr-2">Item</th>
              <th className="py-1 pr-2 text-right">Qty</th>
              <th className="py-1 pr-2 text-right">Rate</th>
              <th className="py-1 text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {bill.lines.map((l) => (
              <tr key={l.id} className="border-b border-black/20 align-top">
                <td className="py-1 pr-2">
                  {l.item_name || l.item?.name || 'Item'}
                  {(l.item_no || l.item?.item_no) && (
                    <span className="fig block text-[11px]">{l.item_no || l.item?.item_no}</span>
                  )}
                </td>
                <td className="fig py-1 pr-2 text-right">{qty(l.quantity)}</td>
                <td className="fig py-1 pr-2 text-right">{c(l.purchase_rate)}</td>
                <td className="fig py-1 text-right">{c(l.total_cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mt-2">
          <Line label="Goods total" value={<span className="fig">{c(bill.goods)}</span>} />
          {bill.postage > 0 && <Line label="Postage / freight" value={<span className="fig">{c(bill.postage)}</span>} />}
          {bill.cgst > 0 && <Line label="CGST" value={<span className="fig">{c(bill.cgst)}</span>} />}
          {bill.sgst > 0 && <Line label="SGST" value={<span className="fig">{c(bill.sgst)}</span>} />}
          <Hr />
          <Line label="Bill total" value={<span className="fig font-bold">{c(bill.grand)}</span>} />
        </div>

        {bill.notes && (
          <>
            <Hr />
            <p className="text-xs">Note: {bill.notes}</p>
          </>
        )}

        <p className="mt-6 text-center text-[11px]">
          Shop's own record of a supplier bill — not a tax invoice.
        </p>
      </div>
    </div>
  )
}

function Line({ label, value }) {
  return (
    <div className="flex justify-between gap-4">
      <span>{label}</span>
      <span className="text-right">{value}</span>
    </div>
  )
}

function Hr() {
  return <div className="my-1.5 border-t border-dashed border-black" />
}
