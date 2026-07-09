import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { IconSearch, IconInbox, IconCoin } from '@tabler/icons-react'
import { supabase } from '../../lib/supabase'
import { useShop } from '../../context/ShopContext'
import { money, qty, dateTime } from '../../lib/format'
import { Badge, Spinner, PhotoThumb } from '../../components/ui'

// SPEC §6.5 / §10.4 — Sales list (owner only). Every approved order becomes a
// sale row (created by the approval insert in OrderDetail; stock/ledger handled
// by the trigger, Golden Rule #10). This is a read-only book of what sold, with
// the filters SPEC §6.5 calls for: date, buyer, payment type, category. Owner is
// the only role that sees profit (Golden Rule #3), so the totals show it here.
const PAYMENT_FILTERS = [
  ['', 'All'], ['cash', 'Cash'], ['upi', 'UPI'], ['udhaar', 'Udhaar'],
]

// Buyer-facing payment label + tone for the row badge.
export const PAYMENT_META = {
  cash:   { label: 'Cash',   tone: 'profit' },
  upi:    { label: 'UPI',    tone: 'peacock' },
  udhaar: { label: 'Udhaar', tone: 'dues' },
}

export default function Sales() {
  const { currency, categories } = useShop()
  const [sales, setSales] = useState(null)
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')
  const [buyerType, setBuyerType] = useState('')
  const [payment, setPayment] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  async function load() {
    setErr('')
    const { data, error } = await supabase
      .from('sales')
      .select(
        'id, quantity, rate_charged, amount, profit, payment_type, buyer_type, category_id, created_at, ' +
          'item_no, item_name, ' +
          'item:items(name, photo_url), ' +
          'buyer:profiles!sales_buyer_id_fkey(full_name, phone), ' +
          'category:categories(name)',
      )
      .order('created_at', { ascending: false })
    if (error) setErr(error.message)
    else setSales(data ?? [])
  }
  useEffect(() => { load() }, [])

  const filtered = useMemo(() => {
    if (!sales) return []
    const needle = q.trim().toLowerCase()
    // Inclusive day bounds — `to` covers the whole selected day.
    const fromTs = from ? new Date(`${from}T00:00:00`).getTime() : null
    const toTs = to ? new Date(`${to}T23:59:59.999`).getTime() : null
    return sales.filter((s) => {
      if (buyerType && s.buyer_type !== buyerType) return false
      if (payment && s.payment_type !== payment) return false
      if (categoryId && s.category_id !== categoryId) return false
      if (fromTs || toTs) {
        const t = new Date(s.created_at).getTime()
        if (fromTs && t < fromTs) return false
        if (toTs && t > toTs) return false
      }
      if (needle) {
        const hay = `${s.item?.name || s.item_name || ''} ${s.buyer?.full_name || ''} ${s.buyer?.phone || ''}`.toLowerCase()
        if (!hay.includes(needle)) return false
      }
      return true
    })
  }, [sales, q, buyerType, payment, categoryId, from, to])

  const totals = useMemo(() => filtered.reduce(
    (a, s) => {
      a.amount += Number(s.amount || 0)
      a.profit += Number(s.profit || 0)
      return a
    },
    { amount: 0, profit: 0 },
  ), [filtered])

  return (
    <div className="space-y-5">
      {/* Totals for the current filter (SPEC §3.2 — every number has a label) */}
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Sales shown" value={<span className="fig">{qty(filtered.length)}</span>} />
        <Stat label="Total amount" value={<span className="fig">{money(totals.amount).replace('₹', currency)}</span>} />
        <Stat label="Total profit" value={<span className="fig text-profit">{money(totals.profit).replace('₹', currency)}</span>} accent />
      </div>

      {/* Filters: search + buyer + category + date, payment as pills */}
      <div className="grid gap-3 rounded-lg border border-line bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="relative sm:col-span-2">
          <IconSearch size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search buyer or item…"
            className="w-full rounded-lg border border-line bg-card py-2.5 pl-9 pr-3 text-ink outline-none focus:border-peacock focus:ring-1 focus:ring-peacock"
          />
        </div>
        <select value={buyerType} onChange={(e) => setBuyerType(e.target.value)}
                className="rounded-lg border border-line bg-card px-3 py-2.5 text-ink outline-none focus:border-peacock focus:ring-1 focus:ring-peacock">
          <option value="">All buyers</option>
          <option value="customer">Customers</option>
          <option value="dealer">Dealers</option>
        </select>
        <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}
                className="rounded-lg border border-line bg-card px-3 py-2.5 text-ink outline-none focus:border-peacock focus:ring-1 focus:ring-peacock">
          <option value="">All categories</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <label className="flex items-center gap-2 text-sm text-muted">
          <span className="shrink-0">From</span>
          <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)}
                 className="w-full rounded-lg border border-line bg-card px-3 py-2.5 text-ink outline-none focus:border-peacock focus:ring-1 focus:ring-peacock" />
        </label>
        <label className="flex items-center gap-2 text-sm text-muted">
          <span className="shrink-0">To</span>
          <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)}
                 className="w-full rounded-lg border border-line bg-card px-3 py-2.5 text-ink outline-none focus:border-peacock focus:ring-1 focus:ring-peacock" />
        </label>
        <div className="flex flex-wrap gap-1.5 sm:col-span-2 lg:col-span-4">
          {PAYMENT_FILTERS.map(([key, label]) => (
            <button
              key={key} type="button" onClick={() => setPayment(key)}
              className={`rounded-full border px-3 py-1.5 text-sm font-medium transition ${
                payment === key ? 'border-peacock bg-peacock text-white' : 'border-line bg-card text-muted hover:text-ink'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {err && <p className="rounded-lg bg-dues/10 px-4 py-3 text-sm text-dues">{err}</p>}

      {sales === null ? (
        <div className="grid place-items-center py-16 text-muted"><Spinner /></div>
      ) : filtered.length === 0 ? (
        <div className="grid place-items-center gap-3 rounded-lg border border-dashed border-line py-16 text-center text-muted">
          <IconInbox size={38} stroke={1.3} />
          <p>{sales.length === 0 ? 'No sales yet. Approve an order to record the first sale.' : 'No sales match these filters.'}</p>
        </div>
      ) : (
        <ul className="space-y-2.5">
          {filtered.map((s) => {
            const pay = PAYMENT_META[s.payment_type] || { label: s.payment_type, tone: 'muted' }
            return (
              <li key={s.id}>
                <Link
                  to={`/owner/sales/${s.id}`}
                  className="flex items-center gap-4 rounded-lg border border-line bg-card p-3 transition hover:border-ink/20"
                >
                  <PhotoThumb url={s.item?.photo_url} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-ink">{s.item?.name || s.item_name || 'Item'}</p>
                    <p className="truncate text-xs text-muted">
                      {s.buyer?.full_name || 'Buyer'}
                      <Badge tone={s.buyer_type === 'dealer' ? 'peacock' : 'muted'} className="ml-1.5">
                        {s.buyer_type}
                      </Badge>
                      <span className="ml-2">{dateTime(s.created_at)}</span>
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="fig font-semibold">{money(s.amount).replace('₹', currency)}</p>
                    <p className="text-xs text-profit">+<span className="fig">{money(s.profit).replace('₹', currency)}</span></p>
                  </div>
                  <Badge tone={pay.tone}>{pay.label}</Badge>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function Stat({ label, value, accent }) {
  return (
    <div className={`rounded-lg border bg-card px-5 py-3 ${accent ? 'border-profit/30' : 'border-line'}`}>
      <p className="flex items-center gap-1.5 text-xs text-muted">
        {accent && <IconCoin size={14} className="text-profit" />}{label}
      </p>
      <p className="mt-0.5 text-2xl font-bold">{value}</p>
    </div>
  )
}

