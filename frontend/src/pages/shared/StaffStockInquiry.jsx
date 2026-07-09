import { useEffect, useMemo, useState } from 'react'
import { IconAlertTriangle } from '@tabler/icons-react'
import { supabase } from '../../lib/supabase'
import { qty } from '../../lib/format'
import { stockStatus } from '../../lib/helpers'
import { StockBadge, Spinner } from '../../components/ui'

// SPEC §6.9/§10.3 — staff Stock Inquiry. Same "what's low?" table as the owner's,
// but sourced from the cost-safe `staff_items` view (no purchase_rate / profit)
// and with NO restock link — staff flag lows for the owner, they don't purchase.
export default function StaffStockInquiry() {
  const [items, setItems] = useState(null)
  const [err, setErr] = useState('')
  const [lowOnly, setLowOnly] = useState(false)
  const [highFirst, setHighFirst] = useState(false) // sort highest-stock first

  useEffect(() => {
    supabase
      .from('staff_items')
      .select('id, item_no, name, quantity, low_stock_threshold, category_name')
      .order('quantity', { ascending: true })
      .then(({ data, error }) => {
        if (error) setErr(error.message)
        else setItems(data ?? [])
      })
  }, [])

  const needsReorder = (i) => {
    const k = stockStatus(i.quantity, i.low_stock_threshold).key
    return k === 'low' || k === 'out'
  }

  const lowCount = useMemo(
    () => (items ? items.filter(needsReorder).length : 0),
    [items],
  )

  const rows = useMemo(() => {
    if (!items) return []
    const base = lowOnly ? items.filter(needsReorder) : items
    return highFirst ? [...base].sort((a, b) => Number(b.quantity) - Number(a.quantity)) : base
  }, [items, lowOnly, highFirst])

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 rounded-lg border border-line bg-card px-5 py-3">
          <IconAlertTriangle size={20} className="text-saffron" />
          <div>
            <p className="text-xs text-muted">Items to reorder</p>
            <p className="fig text-2xl font-bold">{items === null ? '—' : qty(lowCount)}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setLowOnly((v) => !v)}
            className={`rounded-lg border px-4 py-2.5 text-sm font-medium transition ${
              lowOnly ? 'border-saffron bg-saffron/15 text-saffron' : 'border-line bg-card text-muted hover:text-ink'
            }`}
          >
            {lowOnly ? 'Showing low only' : 'Show low only'}
          </button>
          <button
            type="button"
            onClick={() => setHighFirst((v) => !v)}
            className={`rounded-lg border px-4 py-2.5 text-sm font-medium transition ${
              highFirst ? 'border-profit bg-profit/15 text-profit' : 'border-line bg-card text-muted hover:text-ink'
            }`}
          >
            {highFirst ? 'Highest stock first' : 'Show high stock'}
          </button>
        </div>
      </div>

      {err && <p className="rounded-lg bg-dues/10 px-4 py-3 text-sm text-dues">{err}</p>}

      {items === null ? (
        <div className="grid place-items-center py-16 text-muted"><Spinner /></div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-line bg-card">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-paper-2 text-muted">
                <tr>
                  <th className="px-4 py-3 font-medium">Item No</th>
                  <th className="px-4 py-3 font-medium">Name</th>
                  <th className="px-4 py-3 font-medium">Category</th>
                  <th className="px-4 py-3 font-medium text-right">Quantity</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((i) => {
                  const reorder = needsReorder(i)
                  return (
                    <tr key={i.id} className={`border-t border-line ${reorder ? 'bg-saffron/[0.06]' : ''}`}>
                      <td className="px-4 py-3 fig text-muted">{i.item_no}</td>
                      <td className="px-4 py-3 font-medium text-ink">{i.name}</td>
                      <td className="px-4 py-3 text-muted">{i.category_name || '—'}</td>
                      <td className="px-4 py-3 text-right fig">{qty(i.quantity)}</td>
                      <td className="px-4 py-3">
                        <StockBadge quantity={i.quantity} threshold={i.low_stock_threshold} />
                      </td>
                    </tr>
                  )
                })}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-12 text-center text-muted">
                      {lowOnly ? 'Nothing is low on stock right now. 🎉' : 'No active items yet.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
