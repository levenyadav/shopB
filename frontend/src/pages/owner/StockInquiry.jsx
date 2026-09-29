import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { IconAlertTriangle, IconShoppingCartPlus, IconSearch } from '@tabler/icons-react'
import { supabase, fetchAll } from '../../lib/supabase'
import { qty } from '../../lib/format'
import { needsReorder } from '../../lib/helpers'
import useQueryState from '../../hooks/useQueryState'
import { StockBadge, Spinner, Badge } from '../../components/ui'

// SPEC §6.9 — Stock Inquiry. Quick "what do I reorder?" table: Item No, Name,
// Category, Quantity, Status. Sorted lowest-first. One tap on any item opens
// Purchase Entry in restock mode, pre-filled with that item.
//
// View + sort live in the URL (?low=1, ?sort=high) so the Dashboard's "items
// low on stock" line opens this list already filtered, and Back from a restock
// returns to it. "Needs reorder" is the shared rule (needsReorder), so the count
// here is the count on the Dashboard and in Reports.
export default function StockInquiry() {
  const [items, setItems] = useState(null)
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')
  const [low, setLow] = useQueryState('low')
  const [sort, setSort] = useQueryState('sort', 'low')
  const lowOnly = low === '1'

  useEffect(() => {
    fetchAll(() => supabase
      .from('items')
      .select('id, item_no, company_no, name, quantity, low_stock_threshold, discontinued, made_to_order, category:categories(name)')
      .order('quantity', { ascending: true }).order('id'))
      .then(({ data, error }) => {
        if (error) setErr(`Couldn’t load stock: ${error.message}. Refresh to try again.`)
        else setItems(data ?? [])
      })
  }, [])

  const reorderCount = useMemo(() => (items ? items.filter(needsReorder).length : 0), [items])

  const rows = useMemo(() => {
    if (!items) return []
    const needle = q.trim().toLowerCase()
    const base = items.filter((i) => {
      if (lowOnly && !needsReorder(i)) return false
      if (needle && !`${i.item_no} ${i.company_no || ''} ${i.name} ${i.category?.name || ''}`.toLowerCase().includes(needle)) return false
      return true
    })
    // Items load lowest first; "highest first" flips it.
    return sort === 'high' ? [...base].sort((a, b) => Number(b.quantity) - Number(a.quantity)) : base
  }, [items, lowOnly, sort, q])

  return (
    <div className="space-y-5">
      {/* The one number this screen is about — tap it to see just those items. */}
      <button
        type="button" onClick={() => setLow(lowOnly ? '' : '1')} aria-pressed={lowOnly}
        className={`flex items-center gap-3 rounded-lg border px-5 py-3 text-left transition-colors ${
          lowOnly ? 'border-saffron bg-saffron/10' : 'border-line bg-card hover:border-ink/25'
        }`}
      >
        <IconAlertTriangle size={22} className="text-saffron" aria-hidden />
        <span>
          <span className="block text-xs text-muted">Items to reorder (low or out of stock)</span>
          <span className="fig block text-2xl font-bold">{items === null ? '—' : qty(reorderCount)}</span>
        </span>
        <span className="ml-2 text-sm font-medium text-peacock">{lowOnly ? 'Show all items' : 'Show only these'}</span>
      </button>

      <div className="flex flex-wrap gap-2">
        <div className="relative min-w-0 flex-1 basis-60">
          <label htmlFor="stock-search" className="sr-only">Search stock</label>
          <IconSearch size={18} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            id="stock-search" type="search" value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, Item No, Company No…"
            className="h-11 w-full rounded-lg border border-line bg-card pl-9 pr-3 text-ink outline-none focus:border-peacock focus:ring-1 focus:ring-peacock"
          />
        </div>
        <select value={lowOnly ? '1' : ''} onChange={(e) => setLow(e.target.value)} aria-label="Which items"
                className="h-11 rounded-lg border border-line bg-card px-3 text-sm text-ink outline-none focus:border-peacock focus:ring-1 focus:ring-peacock">
          <option value="">All items</option>
          <option value="1">Needs reorder</option>
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort"
                className="h-11 rounded-lg border border-line bg-card px-3 text-sm text-ink outline-none focus:border-peacock focus:ring-1 focus:ring-peacock">
          <option value="low">Lowest stock first</option>
          <option value="high">Highest stock first</option>
        </select>
      </div>

      {err && <p role="alert" className="rounded-lg bg-dues/10 px-4 py-3 text-sm text-dues">{err}</p>}

      {items === null ? (
        !err && <div className="grid place-items-center py-16 text-muted"><Spinner /></div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-line bg-card">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-paper-2 text-muted">
                <tr>
                  <th className="px-4 py-3 font-medium">Item No</th>
                  <th className="px-4 py-3 font-medium">Name</th>
                  <th className="px-4 py-3 font-medium">Category</th>
                  <th className="px-4 py-3 text-right font-medium">Quantity</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium"><span className="sr-only">Action</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((i) => {
                  const reorder = needsReorder(i)
                  return (
                    <tr key={i.id} className={`border-t border-line ${reorder ? 'bg-saffron/[0.06]' : ''}`}>
                      <td className="fig px-4 py-3 text-muted">{i.item_no}</td>
                      <td className="px-4 py-3 font-medium text-ink">
                        {i.name}
                        {i.discontinued && <Badge tone="muted" className="ml-1.5">Discontinued</Badge>}
                        {i.made_to_order && <Badge tone="peacock" className="ml-1.5">Make to order</Badge>}
                      </td>
                      <td className="px-4 py-3 text-muted">{i.category?.name || '—'}</td>
                      <td className="fig px-4 py-3 text-right">{qty(i.quantity)}</td>
                      <td className="px-4 py-3">
                        <StockBadge quantity={i.quantity} threshold={i.low_stock_threshold} />
                      </td>
                      <td className="px-4 py-3 text-right">
                        {!i.discontinued && (
                          <Link
                            to={`/owner/purchase?item=${i.id}`}
                            className={`inline-flex min-h-9 items-center gap-1 rounded-lg px-2.5 text-xs font-semibold ${
                              reorder
                                ? 'bg-peacock text-white hover:bg-peacock-700'
                                : 'border border-line text-muted hover:text-ink'
                            }`}
                          >
                            <IconShoppingCartPlus size={15} aria-hidden /> Restock
                          </Link>
                        )}
                      </td>
                    </tr>
                  )
                })}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-12 text-center text-muted">
                      {q ? 'No item matches that search. Try the Item No or part of the name.'
                        : lowOnly ? 'Nothing needs reordering right now.'
                        : 'No items yet. Add stock with a Purchase Entry.'}
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
