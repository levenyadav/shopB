import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  IconCashRegister, IconShoppingCartPlus, IconCash, IconChevronRight,
  IconReceipt2, IconPackage, IconAlertTriangle, IconCircleCheck,
} from '@tabler/icons-react'
import { supabase, fetchAll } from '../../lib/supabase'
import { useShop } from '../../context/ShopContext'
import { money, qty } from '../../lib/format'
import { stockValue, needsReorder } from '../../lib/helpers'
import { startOfToday, toInputDate } from '../../lib/dates'

// Owner home (SPEC §10.5), in the order the owner uses it:
//   1. the three things they start (Counter Sale, Purchase, Payment),
//   2. what's waiting on them — only the lines that aren't zero,
//   3. today's takings, then 4. where the money stands.
// Every figure is a tap into the screen that acts on it (SPEC §3.4).
export default function Dashboard() {
  const { suppliers, refreshSuppliers } = useShop()
  const [stats, setStats] = useState(null)
  const [err, setErr] = useState('')

  // The supplier-due figure reads ShopContext, loaded once at app start; purchase
  // bills since then raised balances it wouldn't show. Re-read on every visit.
  useEffect(() => { refreshSuppliers() }, [refreshSuppliers])

  useEffect(() => {
    let active = true
    async function load() {
      const todayISO = startOfToday().toISOString()
      const [itemsRes, ordersRes, packRes, salesRes, udhaarRes] = await Promise.all([
        // Stock snapshot — reorder count (shared rule, same as Stock Inquiry)
        // and valuation.
        fetchAll(() => supabase.from('items').select('quantity, purchase_rate, low_stock_threshold, discontinued, made_to_order').order('id')),
        // Orders awaiting approval.
        supabase.from('orders').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
        // Approved orders (shopfront + counter) not yet packed.
        supabase.from('fulfilment').select('id', { count: 'exact', head: true }).eq('status', 'pending_pack'),
        // Today's sales (amount + profit) since local midnight.
        supabase.from('sales').select('id, bill_id, amount, profit').gte('created_at', todayISO),
        // Everyone who owes the shop (udhaar), biggest first.
        fetchAll(() => supabase.from('profiles').select('id, full_name, balance_due')
          .in('role', ['customer', 'dealer']).gt('balance_due', 0)
          .order('balance_due', { ascending: false }).order('id')),
      ])
      if (!active) return

      const firstErr = itemsRes.error || ordersRes.error || packRes.error || salesRes.error || udhaarRes.error
      if (firstErr) { setErr(firstErr.message); return }

      const items = itemsRes.data ?? []
      const sales = salesRes.data ?? []
      const owing = udhaarRes.data ?? []

      setStats({
        pending: ordersRes.count ?? 0,
        toPack: packRes.count ?? 0,
        low: items.filter(needsReorder).length,
        salesToday: sales.reduce((s, r) => s + Number(r.amount || 0), 0),
        profitToday: sales.reduce((s, r) => s + Number(r.profit || 0), 0),
        // A counter bill is several sale rows sharing bill_id — count bills, not rows.
        billsToday: new Set(sales.map((r) => r.bill_id || r.id)).size,
        stockValue: items.reduce((s, i) => s + stockValue(i), 0),
        udhaarTotal: owing.reduce((s, p) => s + Number(p.balance_due || 0), 0),
        udhaarCount: owing.length,
        topUdhaar: owing[0] ?? null,
      })
    }
    load()
    return () => { active = false }
  }, [])

  const owed = suppliers.filter((s) => Number(s.balance_due) > 0)
  const supplierTotal = owed.reduce((s, x) => s + Number(x.balance_due), 0)

  const todo = stats ? [
    { n: stats.pending, to: '/owner/orders?status=pending', icon: IconReceipt2, label: (n) => (n === 1 ? 'order to approve' : 'orders to approve') },
    { n: stats.toPack, to: '/owner/fulfilment', icon: IconPackage, label: (n) => (n === 1 ? 'order to pack' : 'orders to pack') },
    { n: stats.low, to: '/owner/inventory?low=1&sort=low', icon: IconAlertTriangle, label: (n) => (n === 1 ? 'item to reorder (low or out of stock)' : 'items to reorder (low or out of stock)') },
  ].filter((t) => t.n > 0) : []

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="text-sm text-muted">
          {new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}
        </p>
        {/* The three things an owner starts from here (SPEC §10.5). */}
        <div className="flex w-full flex-wrap gap-2 sm:w-auto">
          <Action to="/owner/counter-sale" icon={IconCashRegister} primary className="basis-full sm:basis-auto">Counter Sale</Action>
          <Action to="/owner/purchase" icon={IconShoppingCartPlus}>New Purchase</Action>
          <Action to="/owner/payments" icon={IconCash}>Record Payment</Action>
        </div>
      </div>

      {err && <p role="alert" className="rounded-lg bg-dues/10 px-4 py-3 text-sm text-dues">Couldn’t load the dashboard: {err}. Refresh to try again.</p>}

      {/* Needs attention — a short to-do list, or one calm line. */}
      <section aria-labelledby="todo-h">
        <h2 id="todo-h" className="eyebrow mb-2">Needs attention</h2>
        {!stats ? (
          <div className="h-14 animate-pulse rounded-lg bg-paper-2" />
        ) : todo.length === 0 ? (
          <p className="flex items-center gap-2 rounded-lg border border-line bg-card px-4 py-3.5 text-sm text-ink/80">
            <IconCircleCheck size={20} className="text-profit" aria-hidden /> All caught up — nothing waiting on you.
          </p>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-card">
            {todo.map((t) => (
              <li key={t.to}>
                <Link to={t.to} className="flex min-h-14 items-center gap-3 px-4 transition-colors duration-150 hover:bg-paper-2">
                  <t.icon size={20} className="shrink-0 text-saffron" aria-hidden />
                  <span className="flex-1 font-medium text-ink">
                    <span className="fig">{qty(t.n)}</span> {t.label(t.n)}
                  </span>
                  <IconChevronRight size={18} className="text-muted" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Today */}
      <section aria-labelledby="today-h">
        <h2 id="today-h" className="eyebrow mb-2">Today</h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          <Stat label="Today’s sales" value={stats && money(stats.salesToday)}
                sub={stats && `${qty(stats.billsToday)} ${stats.billsToday === 1 ? 'bill' : 'bills'}`} to={`/owner/sales?from=${toInputDate(new Date())}&to=${toInputDate(new Date())}`} />
          <Stat label="Today’s profit" value={stats && money(stats.profitToday)} tone="profit" to="/owner/reports" />
        </div>
      </section>

      {/* Where the money stands */}
      <section aria-labelledby="money-h">
        <h2 id="money-h" className="eyebrow mb-2">Money & stock</h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          <Stat
            label="Udhaar to collect" value={stats && money(stats.udhaarTotal)} tone={stats?.udhaarTotal > 0 ? 'dues' : null}
            sub={stats && (stats.udhaarCount
              ? `${qty(stats.udhaarCount)} ${stats.udhaarCount === 1 ? 'buyer' : 'buyers'} · most: ${stats.topUdhaar?.full_name || '—'}`
              : 'Nobody owes the shop')}
            to="/owner/parties?tab=buyers&dues=1"
          />
          <Stat
            label="You owe suppliers" value={money(supplierTotal)}
            sub={owed.length ? `${qty(owed.length)} ${owed.length === 1 ? 'supplier' : 'suppliers'}` : 'Nothing owed'}
            to="/owner/parties?tab=supplier&dues=1"
          />
          <Stat label="Stock value (at cost)" value={stats && money(stats.stockValue)} to="/owner/inventory"
                className="col-span-2 lg:col-span-1" />
        </div>
      </section>
    </div>
  )
}

const TONE = { profit: 'text-profit', dues: 'text-dues' }

// A labelled figure that opens the screen behind it. `value` null = loading.
function Stat({ label, value, sub, tone, to, className = '' }) {
  return (
    <Link
      to={to}
      className={`rounded-lg border border-line bg-card p-4 transition-colors duration-150 hover:border-ink/25 ${className}`}
    >
      <p className="text-sm text-muted">{label}</p>
      {value == null
        ? <div className="mt-1.5 h-7 w-24 animate-pulse rounded bg-paper-2" />
        : <p className={`fig mt-0.5 text-2xl font-semibold ${TONE[tone] || 'text-ink'}`}>{value}</p>}
      {sub && <p className="mt-0.5 truncate text-xs text-muted">{sub}</p>}
    </Link>
  )
}

function Action({ to, icon: Icon, primary, className = '', children }) {
  return (
    <Link
      to={to}
      className={`inline-flex h-11 flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-lg px-4 text-sm font-semibold transition-colors duration-150 sm:flex-none ${className} ${
        primary
          ? 'bg-peacock text-white hover:bg-peacock-700'
          : 'border border-line bg-card text-ink hover:bg-paper-2'
      }`}
    >
      <Icon size={18} aria-hidden /> {children}
    </Link>
  )
}
