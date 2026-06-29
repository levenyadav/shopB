import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  IconShoppingCartPlus, IconBoxSeam, IconAlertTriangle, IconBuildingWarehouse,
} from '@tabler/icons-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import { useShop } from '../../context/ShopContext'
import { money, qty } from '../../lib/format'
import { stockValue } from '../../lib/helpers'

// Owner home. The order/sales widgets (SPEC §10.5) need Phase 3 data, so for now
// we surface what the stock books already know: catalogue size, low stock, total
// stock valuation, and the supplier we owe most.
export default function Dashboard() {
  const { profile } = useAuth()
  const { suppliers } = useShop()
  const [stats, setStats] = useState(null)

  useEffect(() => {
    supabase
      .from('items')
      .select('quantity, purchase_rate, low_stock_threshold, is_active')
      .then(({ data }) => {
        const items = data ?? []
        const active = items.filter((i) => i.is_active)
        setStats({
          count: active.length,
          low: active.filter((i) => Number(i.quantity) < Number(i.low_stock_threshold)).length,
          value: items.reduce((s, i) => s + stockValue(i), 0),
        })
      })
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

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          icon={IconBoxSeam} tone="peacock" label="Active items"
          value={stats ? qty(stats.count) : '—'} to="/owner/inventory"
        />
        <Stat
          icon={IconAlertTriangle} tone="saffron" label="Low on stock"
          value={stats ? qty(stats.low) : '—'} to="/owner/stock"
        />
        <Stat
          icon={IconBuildingWarehouse} tone="profit" label="Stock value (at cost)"
          value={stats ? money(stats.value) : '—'} to="/owner/inventory"
        />
        <Stat
          icon={IconShoppingCartPlus} tone="dues" label="Top supplier due"
          value={topSupplier ? money(topSupplier.balance_due) : '₹0'}
          sub={topSupplier?.name} to="/owner/parties"
        />
      </div>

      <section className="rounded-2xl border border-line bg-card p-5">
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">
          Quick actions
        </h3>
        <div className="flex flex-wrap gap-3">
          <Link
            to="/owner/purchase"
            className="inline-flex items-center gap-2 rounded-lg bg-peacock px-4 py-2.5 text-sm font-semibold text-white hover:bg-peacock-700"
          >
            <IconShoppingCartPlus size={18} /> New Purchase Entry
          </Link>
          <Link
            to="/owner/inventory"
            className="inline-flex items-center gap-2 rounded-lg border border-line bg-card px-4 py-2.5 text-sm font-semibold hover:bg-paper-2"
          >
            <IconBoxSeam size={18} /> View Inventory
          </Link>
        </div>
        <p className="mt-4 text-xs text-muted">
          Today's sales, profit and pending orders appear here once Orders &amp; Sales
          go live (Phase 3).
        </p>
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

function Stat({ icon: Icon, tone, label, value, sub, to }) {
  return (
    <Link
      to={to}
      className="group rounded-2xl border border-line bg-card p-5 transition hover:border-peacock/40 hover:shadow-sm"
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
