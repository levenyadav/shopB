import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  IconShoppingCartPlus, IconBoxSeam, IconAlertTriangle, IconBuildingWarehouse,
  IconReceipt2, IconCoin, IconTrendingUp, IconCash, IconUserDollar,
} from '@tabler/icons-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import { useShop } from '../../context/ShopContext'
import { money, qty } from '../../lib/format'
import { stockValue } from '../../lib/helpers'
import { startOfToday } from '../../lib/dates'
import { Spinner } from '../../components/ui'

// Owner home (SPEC §10.5). Pulls the few numbers an owner checks first thing:
// pending orders, today's sales & profit, low stock, the biggest udhaar owed to
// the shop, and the biggest due the shop owes a supplier. Every figure is a tap
// into the screen that acts on it (SPEC §3.4 — no dead ends).
export default function Dashboard() {
  const { profile } = useAuth()
  const { suppliers } = useShop()
  const [stats, setStats] = useState(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    let active = true
    async function load() {
      const todayISO = startOfToday().toISOString()
      const [itemsRes, ordersRes, salesRes, udhaarRes] = await Promise.all([
        // Stock snapshot — active items for count + low, all rows for valuation.
        supabase.from('items').select('quantity, purchase_rate, low_stock_threshold, is_active'),
        // Orders awaiting approval.
        supabase.from('orders').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
        // Today's sales (amount + profit) since local midnight.
        supabase.from('sales').select('amount, profit').gte('created_at', todayISO),
        // Largest outstanding buyer balance (udhaar).
        supabase.from('profiles').select('id, full_name, role, balance_due')
          .in('role', ['customer', 'dealer']).gt('balance_due', 0)
          .order('balance_due', { ascending: false }).limit(1),
      ])
      if (!active) return

      const firstErr = itemsRes.error || ordersRes.error || salesRes.error || udhaarRes.error
      if (firstErr) { setErr(firstErr.message); return }

      const items = itemsRes.data ?? []
      const active_ = items.filter((i) => i.is_active)
      const sales = salesRes.data ?? []

      setStats({
        pending: ordersRes.count ?? 0,
        salesToday: sales.reduce((s, r) => s + Number(r.amount || 0), 0),
        profitToday: sales.reduce((s, r) => s + Number(r.profit || 0), 0),
        low: active_.filter((i) => Number(i.quantity) < Number(i.low_stock_threshold)).length,
        stockValue: items.reduce((s, i) => s + stockValue(i), 0),
        topUdhaar: udhaarRes.data?.[0] ?? null,
      })
    }
    load()
    return () => { active = false }
  }, [])

  const topSupplier = [...suppliers]
    .filter((s) => Number(s.balance_due) > 0)
    .sort((a, b) => Number(b.balance_due) - Number(a.balance_due))[0]

  return (
    <div className="space-y-6">
      <div>
        <p className="text-muted">Welcome back,</p>
        <h2 className="font-[var(--font-display)] text-3xl font-bold">
          {profile?.full_name || 'Owner'}
        </h2>
      </div>

      {err && <p className="rounded-lg bg-dues/10 px-4 py-3 text-sm text-dues">{err}</p>}

      {/* Today + queue — what the owner acts on first */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          icon={IconReceipt2} tone="saffron" label="Pending orders"
          value={stats ? qty(stats.pending) : <Dash />}
          sub={stats?.pending ? 'Waiting for approval' : 'All caught up'}
          to="/owner/orders"
        />
        <Stat
          icon={IconCoin} tone="peacock" label="Today's sales"
          value={stats ? money(stats.salesToday) : <Dash />} to="/owner/reports"
        />
        <Stat
          icon={IconTrendingUp} tone="profit" label="Today's profit"
          value={stats ? money(stats.profitToday) : <Dash />} to="/owner/reports"
        />
        <Stat
          icon={IconAlertTriangle} tone="saffron" label="Low on stock"
          value={stats ? qty(stats.low) : <Dash />}
          sub={stats?.low ? 'Tap to reorder' : 'Stock healthy'}
          to="/owner/stock"
        />
      </div>

      {/* Standing position — stock value + who owes whom */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Stat
          icon={IconBuildingWarehouse} tone="peacock" label="Stock value (at cost)"
          value={stats ? money(stats.stockValue) : <Dash />} to="/owner/inventory"
        />
        <Stat
          icon={IconUserDollar} tone="dues" label="Top udhaar owed to shop"
          value={stats ? money(stats.topUdhaar?.balance_due || 0) : <Dash />}
          sub={stats?.topUdhaar?.full_name || 'No udhaar pending'}
          to="/owner/parties"
        />
        <Stat
          icon={IconBuildingWarehouse} tone="dues" label="Top supplier due"
          value={topSupplier ? money(topSupplier.balance_due) : '₹0'}
          sub={topSupplier?.name || 'Nothing owed'}
          to="/owner/parties"
        />
      </div>

      {/* Quick actions (SPEC §10.5) */}
      <section className="rounded-lg border border-line bg-card p-5">
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">
          Quick actions
        </h3>
        <div className="flex flex-wrap gap-3">
          <QuickAction to="/owner/purchase" icon={IconShoppingCartPlus} primary>
            New Purchase
          </QuickAction>
          <QuickAction to="/owner/orders" icon={IconReceipt2}>
            View Orders
          </QuickAction>
          <QuickAction to="/owner/payments" icon={IconCash}>
            Record Payment
          </QuickAction>
        </div>
      </section>
    </div>
  )
}

const STAT_TONES = {
  peacock: 'bg-peacock/10 text-peacock',
  saffron: 'bg-saffron/15 text-saffron',
  profit: 'bg-profit/10 text-profit',
  dues: 'bg-dues/10 text-dues',
}

function Dash() {
  return <Spinner className="text-muted" />
}

function Stat({ icon: Icon, tone, label, value, sub, to }) {
  return (
    <Link
      to={to}
      className="group rounded-lg border border-line bg-card p-5 transition hover:border-peacock/40 hover:border-ink/20"
    >
      <div className={`mb-3 grid h-10 w-10 place-items-center rounded-lg ${STAT_TONES[tone]}`}>
        <Icon size={20} />
      </div>
      <p className="text-sm text-muted">{label}</p>
      <p className="fig mt-0.5 text-2xl font-bold">{value}</p>
      {sub && <p className="mt-0.5 truncate text-xs text-muted">{sub}</p>}
    </Link>
  )
}

function QuickAction({ to, icon: Icon, primary, children }) {
  return (
    <Link
      to={to}
      className={`inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition ${
        primary
          ? 'bg-peacock text-white hover:bg-peacock-700'
          : 'border border-line bg-card hover:bg-paper-2'
      }`}
    >
      <Icon size={18} /> {children}
    </Link>
  )
}
