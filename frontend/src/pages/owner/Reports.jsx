import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  IconCoin, IconTrendingUp, IconReceipt2, IconBuildingWarehouse,
  IconAlertTriangle, IconCircleOff, IconShoppingCartPlus,
} from '@tabler/icons-react'
import { supabase } from '../../lib/supabase'
import { money, qty } from '../../lib/format'
import { stockValue, stockStatus } from '../../lib/helpers'
import {
  startOfToday, startOfWeek, startOfMonth, toInputDate, fromInputDate, endOfInputDate,
} from '../../lib/dates'
import { Spinner } from '../../components/ui'

// SPEC §6.10 — Reports & Accounting (owner only). One screen, computed entirely
// from the sales + items the owner can already read. Sales analytics sit up top
// (today / week / month, then a free date-range P&L); stock valuation sits below.
export default function Reports() {
  const [sales, setSales] = useState(null)
  const [items, setItems] = useState(null)
  const [err, setErr] = useState('')

  const [from, setFrom] = useState(() => toInputDate(startOfMonth()))
  const [to, setTo] = useState(() => toInputDate(startOfToday()))

  useEffect(() => {
    let active = true
    async function load() {
      const [sRes, iRes] = await Promise.all([
        supabase.from('sales')
          .select('amount, profit, quantity, buyer_type, created_at, item:items(name), category:categories(name)')
          .order('created_at', { ascending: false }),
        supabase.from('items')
          .select('id, item_no, name, quantity, purchase_rate, low_stock_threshold, is_active')
          .eq('is_active', true),
      ])
      if (!active) return
      if (sRes.error) { setErr(sRes.error.message); return }
      if (iRes.error) { setErr(iRes.error.message); return }
      setSales(sRes.data ?? [])
      setItems(iRes.data ?? [])
    }
    load()
    return () => { active = false }
  }, [])

  // Fixed period summaries (SPEC §6.10 — today / this week / this month).
  const periods = useMemo(() => {
    if (!sales) return null
    const since = (d) => sumSales(sales.filter((s) => new Date(s.created_at) >= d))
    return {
      today: since(startOfToday()),
      week: since(startOfWeek()),
      month: since(startOfMonth()),
    }
  }, [sales])

  // Free-range slice drives the P&L, category and top-item sections.
  const ranged = useMemo(() => {
    if (!sales) return []
    const lo = fromInputDate(from)
    const hi = endOfInputDate(to)
    return sales.filter((s) => {
      const t = new Date(s.created_at)
      return t >= lo && t <= hi
    })
  }, [sales, from, to])

  const pnl = useMemo(() => summarisePnl(ranged), [ranged])
  const byCategory = useMemo(() => groupBy(ranged, (s) => s.category?.name || 'Uncategorised'), [ranged])
  const topByRevenue = useMemo(() => topItems(ranged, 'amount'), [ranged])
  const topByQty = useMemo(() => topItems(ranged, 'quantity'), [ranged])

  const stock = useMemo(() => {
    if (!items) return null
    const zero = items.filter((i) => Number(i.quantity) <= 0)
    const low = items.filter((i) => {
      const k = stockStatus(i.quantity, i.low_stock_threshold).key
      return k === 'low'
    })
    return {
      value: items.reduce((s, i) => s + stockValue(i), 0),
      count: items.length,
      low: low.length,
      zero,
    }
  }, [items])

  if (err) return <p className="rounded-lg bg-dues/10 px-4 py-3 text-sm text-dues">{err}</p>
  if (!sales || !items) return <div className="grid place-items-center py-20 text-muted"><Spinner /></div>

  const revenueMax = Math.max(1, ...byCategory.map((c) => c.amount))

  return (
    <div className="space-y-8">
      {/* ---- Sales at a glance ---- */}
      <section className="space-y-3">
        <SectionTitle>Sales summary</SectionTitle>
        <div className="grid gap-4 sm:grid-cols-3">
          <PeriodCard label="Today" data={periods.today} />
          <PeriodCard label="This week" data={periods.week} />
          <PeriodCard label="This month" data={periods.month} />
        </div>
      </section>

      {/* ---- Profit & Loss for a chosen range ---- */}
      <section className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <SectionTitle>Profit &amp; Loss</SectionTitle>
          <div className="flex items-end gap-2">
            <DateInput label="From" value={from} max={to} onChange={setFrom} />
            <DateInput label="To" value={to} min={from} max={toInputDate(startOfToday())} onChange={setTo} />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat icon={IconReceipt2} tone="peacock" label="Sales (revenue)" value={money(pnl.revenue)} />
          <Stat icon={IconBuildingWarehouse} tone="saffron" label="Cost of goods" value={money(pnl.cost)} />
          <Stat icon={IconTrendingUp} tone="profit" label="Profit" value={money(pnl.profit)} />
          <Stat icon={IconCoin} tone="muted" label="Orders sold" value={qty(pnl.orders)} />
        </div>

        {/* Profit by buyer type (SPEC §6.10 P&L) */}
        <div className="grid gap-4 sm:grid-cols-2">
          <SplitCard title="Profit by buyer type" rows={[
            { label: 'Customers (retail)', amount: pnl.byType.customer.profit, sub: money(pnl.byType.customer.revenue) + ' sales' },
            { label: 'Dealers (wholesale)', amount: pnl.byType.dealer.profit, sub: money(pnl.byType.dealer.revenue) + ' sales' },
          ]} />
          <div className="rounded-lg border border-line bg-card p-5">
            <p className="mb-3 text-sm font-semibold text-ink">Margin</p>
            <p className="fig text-3xl font-bold text-profit">
              {pnl.revenue > 0 ? Math.round((pnl.profit / pnl.revenue) * 100) : 0}%
            </p>
            <p className="mt-1 text-xs text-muted">
              Profit as a share of sales in this range.
            </p>
          </div>
        </div>
      </section>

      {/* ---- Sales by category ---- */}
      <section className="space-y-3">
        <SectionTitle>Sales by category</SectionTitle>
        <div className="rounded-lg border border-line bg-card p-5">
          {byCategory.length === 0 ? (
            <Empty>No sales in this range.</Empty>
          ) : (
            <ul className="space-y-3">
              {byCategory.map((c) => (
                <li key={c.key}>
                  <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
                    <span className="font-medium text-ink">{c.key}</span>
                    <span className="fig text-muted">
                      {money(c.amount)} · <span className="text-profit">{money(c.profit)} profit</span>
                    </span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-paper-2">
                    <div className="h-full rounded-full bg-peacock" style={{ width: `${(c.amount / revenueMax) * 100}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* ---- Top items ---- */}
      <section className="space-y-3">
        <SectionTitle>Top items</SectionTitle>
        <div className="grid gap-4 lg:grid-cols-2">
          <TopList title="By revenue" rows={topByRevenue} render={(r) => money(r.amount)} />
          <TopList title="By quantity sold" rows={topByQty} render={(r) => qty(r.quantity) + ' sold'} />
        </div>
      </section>

      {/* ---- Stock valuation ---- */}
      <section className="space-y-3">
        <SectionTitle>Stock valuation</SectionTitle>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat icon={IconBuildingWarehouse} tone="peacock" label="Stock value (at cost)" value={money(stock.value)} />
          <Stat icon={IconReceipt2} tone="muted" label="Active items" value={qty(stock.count)} />
          <Stat icon={IconAlertTriangle} tone="saffron" label="Low on stock" value={qty(stock.low)} to="/owner/stock" />
          <Stat icon={IconCircleOff} tone="dues" label="Zero stock" value={qty(stock.zero.length)} />
        </div>

        {stock.zero.length > 0 && (
          <div className="overflow-hidden rounded-lg border border-line bg-card">
            <div className="border-b border-line bg-paper-2 px-4 py-2.5 text-sm font-semibold text-ink">
              Items with zero stock — reorder soon
            </div>
            <ul className="divide-y divide-line">
              {stock.zero.map((i) => (
                <li key={i.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-ink">{i.name}</p>
                    <p className="fig text-xs text-muted">{i.item_no}</p>
                  </div>
                  <Link
                    to={`/owner/purchase?item=${i.id}`}
                    className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-peacock px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-peacock-700"
                  >
                    <IconShoppingCartPlus size={15} /> Restock
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  )
}

// ---- aggregation helpers ----

function sumSales(rows) {
  return {
    revenue: rows.reduce((s, r) => s + Number(r.amount || 0), 0),
    profit: rows.reduce((s, r) => s + Number(r.profit || 0), 0),
    orders: rows.length,
  }
}

function summarisePnl(rows) {
  const base = sumSales(rows)
  const byType = {
    customer: sumSales(rows.filter((r) => r.buyer_type === 'customer')),
    dealer: sumSales(rows.filter((r) => r.buyer_type === 'dealer')),
  }
  return { ...base, cost: base.revenue - base.profit, byType }
}

function groupBy(rows, keyFn) {
  const map = new Map()
  for (const r of rows) {
    const key = keyFn(r)
    const cur = map.get(key) || { key, amount: 0, profit: 0, quantity: 0 }
    cur.amount += Number(r.amount || 0)
    cur.profit += Number(r.profit || 0)
    cur.quantity += Number(r.quantity || 0)
    map.set(key, cur)
  }
  return [...map.values()].sort((a, b) => b.amount - a.amount)
}

function topItems(rows, sortKey) {
  return groupBy(rows, (r) => r.item?.name || 'Unknown item')
    .sort((a, b) => b[sortKey] - a[sortKey])
    .slice(0, 10)
}

// ---- presentational ----

function SectionTitle({ children }) {
  return <h3 className="text-sm font-semibold uppercase tracking-wider text-muted">{children}</h3>
}

const STAT_TONES = {
  peacock: 'bg-peacock/10 text-peacock',
  saffron: 'bg-saffron/15 text-saffron',
  profit: 'bg-profit/10 text-profit',
  dues: 'bg-dues/10 text-dues',
  muted: 'bg-paper-2 text-muted',
}

function Stat({ icon: Icon, tone, label, value, to }) {
  const inner = (
    <>
      <div className={`mb-3 grid h-10 w-10 place-items-center rounded-lg ${STAT_TONES[tone]}`}>
        <Icon size={20} />
      </div>
      <p className="text-sm text-muted">{label}</p>
      <p className="fig mt-0.5 text-2xl font-bold">{value}</p>
    </>
  )
  const cls = 'block rounded-lg border border-line bg-card p-5'
  return to
    ? <Link to={to} className={`${cls} transition hover:border-peacock/40 hover:border-ink/20`}>{inner}</Link>
    : <div className={cls}>{inner}</div>
}

function PeriodCard({ label, data }) {
  return (
    <div className="rounded-lg border border-line bg-card p-5">
      <p className="text-sm font-semibold text-ink">{label}</p>
      <p className="mt-2 text-xs text-muted">Sales</p>
      <p className="fig text-2xl font-bold text-peacock">{money(data.revenue)}</p>
      <p className="mt-2 text-xs text-muted">Profit</p>
      <p className="fig text-xl font-bold text-profit">{money(data.profit)}</p>
      <p className="mt-2 text-xs text-muted">{qty(data.orders)} orders</p>
    </div>
  )
}

function SplitCard({ title, rows }) {
  return (
    <div className="rounded-lg border border-line bg-card p-5">
      <p className="mb-3 text-sm font-semibold text-ink">{title}</p>
      <ul className="space-y-3">
        {rows.map((r) => (
          <li key={r.label} className="flex items-baseline justify-between gap-3">
            <div>
              <p className="text-sm text-ink">{r.label}</p>
              <p className="text-xs text-muted">{r.sub}</p>
            </div>
            <p className="fig text-lg font-bold text-profit">{money(r.amount)}</p>
          </li>
        ))}
      </ul>
    </div>
  )
}

function TopList({ title, rows, render }) {
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-card">
      <div className="border-b border-line bg-paper-2 px-4 py-2.5 text-sm font-semibold text-ink">{title}</div>
      {rows.length === 0 ? (
        <Empty>No sales in this range.</Empty>
      ) : (
        <ol className="divide-y divide-line">
          {rows.map((r, idx) => (
            <li key={r.key} className="flex items-center justify-between gap-3 px-4 py-2.5">
              <span className="flex min-w-0 items-center gap-3">
                <span className="fig w-5 shrink-0 text-right text-xs text-muted">{idx + 1}</span>
                <span className="truncate text-sm text-ink">{r.key}</span>
              </span>
              <span className="fig shrink-0 text-sm font-semibold text-ink">{render(r)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

function DateInput({ label, value, min, max, onChange }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
      <input
        type="date"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(e.target.value)}
        className="fig rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink outline-none focus:border-peacock focus:ring-1 focus:ring-peacock"
      />
    </label>
  )
}

function Empty({ children }) {
  return <p className="px-4 py-8 text-center text-sm text-muted">{children}</p>
}
