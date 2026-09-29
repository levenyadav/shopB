import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  IconShoppingCartPlus, IconPencil, IconArrowDownLeft, IconArrowUpRight, IconInbox,
} from '@tabler/icons-react'
import { supabase, fetchAll } from '../../lib/supabase'
import { useShop } from '../../context/ShopContext'
import { money, qty, dateTime } from '../../lib/format'
import { stockValue, needsReorder } from '../../lib/helpers'
import { Badge, Spinner, StockBadge, PhotoThumb } from '../../components/ui'

// One product, everything about it on one screen (SPEC §3.2): where its stock
// sits, what it costs and sells for, and every movement — each purchase line
// that brought stock in and each sale that took it out, newest first. Reads
// only; stock moves by trigger (Golden Rules #1, #2, #10).
//
// A direct quantity correction made from Inventory → Edit has no movement row
// of its own, so it cannot appear in this list — the footer says so.
export default function ItemHistory() {
  const { id } = useParams()
  const { warehouses } = useShop()
  const [item, setItem] = useState(null)
  const [moves, setMoves] = useState(null)
  const [whStock, setWhStock] = useState([])
  const [err, setErr] = useState('')
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    let active = true
    async function load() {
      setErr(''); setMissing(false)
      const purchaseCols =
        'id, quantity, purchase_rate, total_cost, created_at, invoice_no, supplier:suppliers(id, name)'
      const [iRes, wRes, sRes] = await Promise.all([
        supabase.from('items')
          .select('id, item_no, company_no, name, quantity, purchase_rate, dealer_rate, rate, low_stock_threshold, ' +
                  'photo_url, is_active, discontinued, made_to_order, location, category:categories(name), supplier:suppliers(name)')
          .eq('id', id).maybeSingle(),
        supabase.from('warehouse_stock').select('warehouse_id, quantity').eq('item_id', id),
        fetchAll(() => supabase.from('sales')
          .select('id, quantity, rate_charged, amount, created_at, buyer_type, source, buyer:profiles!sales_buyer_id_fkey(id, full_name)')
          .eq('item_id', id).order('created_at', { ascending: false }).order('id')),
      ])
      // Lines removed by a bill edit are soft-deleted (039) and worth no stock;
      // a database short of 039 has no deleted_at column, so fall back.
      let pRes = await fetchAll(() => supabase.from('purchases').select(purchaseCols)
        .eq('item_id', id).is('deleted_at', null).order('created_at', { ascending: false }).order('id'))
      if (pRes.error && /deleted_at/.test(pRes.error.message || '')) {
        pRes = await fetchAll(() => supabase.from('purchases').select(purchaseCols)
          .eq('item_id', id).order('created_at', { ascending: false }).order('id'))
      }
      if (!active) return
      if (iRes.error) { setErr(iRes.error.message); return }
      if (!iRes.data) { setMissing(true); return }
      setItem(iRes.data)
      setWhStock((wRes.data ?? []).filter((w) => Number(w.quantity) !== 0))
      const firstErr = sRes.error || pRes.error
      if (firstErr) setErr(`Some history could not be loaded: ${firstErr.message}. Refresh to try again.`)
      const ins = (pRes.data ?? []).map((p) => ({
        key: `p-${p.id}`, dir: 'in', at: p.created_at, quantity: Number(p.quantity),
        rate: p.purchase_rate, amount: p.total_cost, who: p.supplier?.name || 'Supplier',
        whoTo: p.supplier?.id ? `/owner/parties/supplier/${p.supplier.id}` : null,
        ref: p.invoice_no ? `Bill ${p.invoice_no}` : 'Purchase', to: `/owner/purchases/${p.id}`,
      }))
      const outs = (sRes.data ?? []).map((s) => ({
        key: `s-${s.id}`, dir: 'out', at: s.created_at, quantity: Number(s.quantity),
        rate: s.rate_charged, amount: s.amount, who: s.buyer?.full_name || 'Buyer',
        whoTo: s.buyer?.id ? `/owner/parties/${s.buyer_type}/${s.buyer.id}` : null,
        ref: s.source === 'counter' ? 'Counter sale' : 'Shopfront sale', to: `/owner/sales/${s.id}`,
      }))
      setMoves([...ins, ...outs].sort((a, b) => b.at.localeCompare(a.at)))
    }
    load()
    return () => { active = false }
  }, [id])

  const totals = useMemo(() => {
    const t = { in: 0, out: 0, sold30: 0 }
    const since = Date.now() - 30 * 864e5
    for (const m of moves ?? []) {
      t[m.dir] += m.quantity
      if (m.dir === 'out' && new Date(m.at).getTime() >= since) t.sold30 += m.quantity
    }
    return t
  }, [moves])

  const whName = useMemo(() => Object.fromEntries(warehouses.map((w) => [w.id, w.name])), [warehouses])

  if (missing) return (
    <Empty>This item no longer exists. <Link to="/owner/inventory" className="font-medium text-peacock hover:underline">Back to inventory</Link>.</Empty>
  )
  if (err && !item) return <Empty>{err}</Empty>
  if (!item) return <div className="grid place-items-center py-20 text-muted"><Spinner /></div>

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      {/* Who it is + the two things you do to it */}
      <div className="flex flex-wrap items-start gap-4 rounded-lg border border-line bg-card p-4">
        <PhotoThumb url={item.photo_url} size="h-20 w-20" alt={item.name} />
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-bold text-ink">{item.name}</h2>
          <p className="fig text-sm text-muted">
            {item.item_no}{item.company_no ? ` · Company No ${item.company_no}` : ''}
          </p>
          <p className="text-sm text-muted">
            {item.category?.name || 'No category'} · {item.supplier?.name || 'No supplier'}
            {item.location ? ` · Rack ${item.location}` : ''}
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {item.discontinued && <Badge tone="dues">Discontinued</Badge>}
            {!item.discontinued && !item.is_active && <Badge tone="muted">Hidden from shop</Badge>}
            {item.made_to_order && <Badge tone="peacock">Make to order</Badge>}
          </div>
        </div>
        <div className="flex w-full gap-2 sm:w-auto">
          {!item.discontinued && (
            <Link to={`/owner/purchase?item=${item.id}`}
                  className={`inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold sm:flex-none ${
                    needsReorder(item) ? 'bg-peacock text-white hover:bg-peacock-700' : 'border border-line bg-card text-ink hover:bg-paper-2'
                  }`}>
              <IconShoppingCartPlus size={18} aria-hidden /> Restock
            </Link>
          )}
          <Link to={`/owner/inventory?edit=${item.id}`}
                className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-lg border border-line bg-card px-4 text-sm font-semibold text-ink hover:bg-paper-2 sm:flex-none">
            <IconPencil size={18} aria-hidden /> Edit
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="In stock now" value={item.made_to_order ? 'Made to order' : `${qty(item.quantity)} pcs`}
              extra={!item.made_to_order && <StockBadge quantity={item.quantity} threshold={item.low_stock_threshold} />} />
        <Stat label="Stock value (at cost)" value={money(stockValue(item))} />
        <Stat label="Sold in last 30 days" value={`${qty(totals.sold30)} pcs`} />
        <Stat label="Reorder below" value={`${qty(item.low_stock_threshold)} pcs`} />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-line bg-card p-4">
          <p className="eyebrow mb-2">Rates</p>
          <dl className="space-y-1.5 text-sm">
            <RateRow label="Purchase rate (cost)" value={item.purchase_rate} />
            <RateRow label="Dealer rate" value={item.dealer_rate} />
            <RateRow label="Retail rate" value={item.rate} />
          </dl>
        </div>
        <div className="rounded-lg border border-line bg-card p-4">
          <p className="eyebrow mb-2">Where the stock is</p>
          {whStock.length === 0 ? (
            <p className="text-sm text-muted">{warehouses.length ? 'No stock in any warehouse.' : 'Warehouses are not set up.'}</p>
          ) : (
            <dl className="space-y-1.5 text-sm">
              {whStock.map((w) => (
                <div key={w.warehouse_id} className="flex justify-between gap-3">
                  <dt className="text-muted">{whName[w.warehouse_id] || 'Warehouse'}</dt>
                  <dd className="fig font-medium">{qty(w.quantity)} pcs</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </div>

      <section aria-labelledby="moves-h">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="moves-h" className="eyebrow">Stock movements</h2>
          {moves && (
            <p className="text-xs text-muted">
              Bought in <span className="fig font-medium text-ink">{qty(totals.in)}</span> · Sold <span className="fig font-medium text-ink">{qty(totals.out)}</span>
            </p>
          )}
        </div>
        {err && <p role="alert" className="mb-3 rounded-lg bg-dues/10 px-4 py-3 text-sm text-dues">{err}</p>}
        {moves === null ? (
          <div className="grid place-items-center py-10 text-muted"><Spinner /></div>
        ) : moves.length === 0 ? (
          <div className="grid place-items-center gap-2 rounded-lg border border-dashed border-line py-10 text-center text-sm text-muted">
            <IconInbox size={30} stroke={1.3} aria-hidden />
            No purchases or sales of this item yet.
          </div>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-card">
            {moves.map((m) => {
              const inbound = m.dir === 'in'
              return (
                <li key={m.key} className="flex items-center gap-3 px-4 py-2.5">
                  <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full ${inbound ? 'bg-profit/10 text-profit' : 'bg-peacock/10 text-peacock'}`}>
                    {inbound ? <IconArrowDownLeft size={16} aria-hidden /> : <IconArrowUpRight size={16} aria-hidden />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <Link to={m.to} className="block truncate text-sm font-medium text-ink hover:text-peacock">
                      {m.ref} <span className="font-normal text-muted">· {money(m.rate)} each · {money(m.amount)}</span>
                    </Link>
                    <p className="truncate text-xs text-muted">
                      {inbound ? 'From ' : 'To '}
                      {m.whoTo ? <Link to={m.whoTo} className="hover:text-ink hover:underline">{m.who}</Link> : m.who}
                      {' · '}{dateTime(m.at)}
                    </p>
                  </div>
                  <span className={`fig shrink-0 font-semibold ${inbound ? 'text-profit' : 'text-ink'}`}>
                    {inbound ? '+' : '−'}{qty(m.quantity)}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
        <p className="mt-2 text-xs text-muted">
          Quantity corrections made with Inventory → Edit are not listed here.
        </p>
      </section>
    </div>
  )
}

function Stat({ label, value, extra }) {
  return (
    <div className="rounded-lg border border-line bg-card p-4">
      <p className="text-sm text-muted">{label}</p>
      <p className="fig mt-0.5 text-xl font-semibold text-ink">{value}</p>
      {extra && <div className="mt-1">{extra}</div>}
    </div>
  )
}

function RateRow({ label, value }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className="fig font-medium">{money(value)}</dd>
    </div>
  )
}

function Empty({ children }) {
  return <p className="mx-auto max-w-md rounded-lg border border-line bg-card px-5 py-10 text-center text-muted">{children}</p>
}
