import { useState } from 'react'
import { Outlet, Link, NavLink, useLocation } from 'react-router-dom'
import {
  IconBuildingStore, IconLogout, IconClipboardCheck, IconCashRegister,
  IconBoxSeam, IconClipboardList, IconMenu2, IconX,
} from '@tabler/icons-react'
import { useAuth } from '../context/AuthContext'
import { useShop } from '../context/ShopContext'
import Brand from './Brand'
import BackButton from './BackButton'

// SPEC §10.3 — Staff console. Two jobs: pack the fulfilment board, and ring up
// walk-ins at the counter (POS, SPEC §6.5a). Sidebar switches between them —
// same shell as the owner console so the two consoles feel like one register.
const NAV = [
  { to: '/staff', end: true, label: 'Fulfilment', icon: IconClipboardCheck },
  { to: '/staff/counter-sale', label: 'New Sale', icon: IconCashRegister },
  { to: '/staff/inventory', label: 'Inventory', icon: IconBoxSeam },
  { to: '/staff/stock', label: 'Stock', icon: IconClipboardList },
]

const TITLES = {
  '/staff': 'Fulfilment',
  '/staff/counter-sale': 'New Sale',
  '/staff/inventory': 'Inventory',
  '/staff/stock': 'Stock',
}

export default function StaffLayout() {
  const { profile, signOut } = useAuth()
  const { shop } = useShop()
  const { pathname } = useLocation()
  const [open, setOpen] = useState(false)
  const onFulfilment = pathname === '/staff' || pathname.startsWith('/staff/fulfil')

  const title =
    TITLES[pathname] ||
    Object.entries(TITLES)
      .filter(([p]) => p !== '/staff' && pathname.startsWith(p))
      .map(([, t]) => t)[0] ||
    'Fulfilment'

  return (
    <div className="min-h-screen bg-paper md:grid md:grid-cols-[16rem_1fr]">
      <Sidebar shop={shop} open={open} onClose={() => setOpen(false)} />

      <div className="flex min-h-screen flex-col">
        <header className="no-print sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-line bg-card px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-2">
            <button
              className="rounded-lg p-1.5 text-muted hover:bg-paper-2 md:hidden"
              onClick={() => setOpen(true)}
              aria-label="Open menu"
            >
              <IconMenu2 size={22} />
            </button>
            <BackButton hideAt="md" />
            <h1 className="truncate font-[var(--font-display)] text-xl font-bold">{title}</h1>
          </div>

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
        </header>

        <main className="flex-1 px-4 py-6 sm:px-6 sm:py-8">
          {onFulfilment && (
            <p className="no-print mb-5 text-sm text-muted">
              {profile?.full_name ? `${profile.full_name.split(' ')[0]}, p` : 'P'}ack approved orders and mark them out.
            </p>
          )}
          <Outlet />
        </main>
      </div>
    </div>
  )
}

function Sidebar({ shop, open, onClose }) {
  return (
    <>
      {open && (
        <div className="no-print fixed inset-0 z-30 bg-ink/30 md:hidden" onClick={onClose} />
      )}
      <aside
        className={`no-print fixed inset-y-0 left-0 z-40 w-64 transform border-r border-line bg-paper-2 transition-transform md:static md:translate-x-0 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between px-5 py-4">
          <Link to="/staff" onClick={onClose}>
            <Brand shop={shop} maxWords={2} textClassName="text-[10px]" logoClassName="h-9" />
          </Link>
          <button className="rounded-lg p-1 text-muted hover:bg-paper md:hidden" onClick={onClose} aria-label="Close menu">
            <IconX size={20} />
          </button>
        </div>

        <nav className="px-3 py-2">
          <ul className="space-y-0.5">
            {NAV.map((it) => (
              <li key={it.to}>
                <NavLink
                  to={it.to}
                  end={it.end}
                  onClick={onClose}
                  className={({ isActive }) =>
                    `flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                      isActive
                        ? 'bg-card font-semibold text-peacock shadow-[inset_2px_0_0_var(--color-saffron)]'
                        : 'font-medium text-ink/75 hover:bg-paper hover:text-ink'
                    }`
                  }
                >
                  <it.icon size={19} stroke={1.7} />
                  <span className="flex-1">{it.label}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </aside>
    </>
  )
}
