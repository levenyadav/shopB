import { Outlet, Link, NavLink, useLocation } from 'react-router-dom'
import {
  IconBuildingStore, IconLogout, IconClipboardCheck, IconCashRegister,
} from '@tabler/icons-react'
import { useAuth } from '../context/AuthContext'
import { useShop } from '../context/ShopContext'

// SPEC §10.3 — Staff console. Two jobs: pack the fulfilment board, and ring up
// walk-ins at the counter (POS, SPEC §6.5a). Tabs switch between them.
const TABS = [
  { to: '/staff', end: true, label: 'Fulfilment', icon: IconClipboardCheck },
  { to: '/staff/counter-sale', label: 'New Sale', icon: IconCashRegister },
]

export default function StaffLayout() {
  const { profile, signOut } = useAuth()
  const { shop } = useShop()
  const { pathname } = useLocation()
  const onFulfilment = pathname === '/staff' || pathname.startsWith('/staff/fulfil')

  return (
    <div className="min-h-screen bg-paper">
      <header className="no-print sticky top-0 z-20 border-b border-line bg-card">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <Link to="/staff" className="flex items-center gap-2">
            <span className="shop-stamp text-[10px] font-bold">
              {shop?.name?.split(' ').slice(0, 2).join(' ') || 'Shop'}
            </span>
          </Link>

          <nav className="flex items-center gap-1">
            {TABS.map((t) => (
              <NavLink
                key={t.to} to={t.to} end={t.end}
                className={({ isActive }) =>
                  `inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                    isActive ? 'bg-peacock/10 text-peacock' : 'text-ink/75 hover:bg-paper-2 hover:text-ink'
                  }`
                }
              >
                <t.icon size={18} stroke={1.7} /> <span className="hidden sm:inline">{t.label}</span>
              </NavLink>
            ))}
          </nav>

          <div className="flex items-center gap-2">
            <Link
              to="/"
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-ink/80 hover:bg-paper-2"
            >
              <IconBuildingStore size={18} /> <span className="hidden sm:inline">Shop</span>
            </Link>
            <button
              onClick={signOut}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-card px-3 py-2 text-sm font-medium text-muted hover:text-ink"
            >
              <IconLogout size={18} /> <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-8">
        {onFulfilment && (
          <div className="no-print mb-5">
            <h1 className="font-[var(--font-display)] text-2xl font-bold">Fulfilment</h1>
            <p className="text-sm text-muted">
              {profile?.full_name ? `${profile.full_name.split(' ')[0]}, p` : 'P'}ack approved orders and mark them out.
            </p>
          </div>
        )}
        <Outlet />
      </main>
    </div>
  )
}
