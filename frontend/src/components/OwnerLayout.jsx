import { useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import {
  IconLayoutDashboard, IconShoppingCartPlus, IconBoxSeam, IconClipboardList,
  IconReceipt2, IconCoin, IconCash, IconUsers, IconChartBar, IconSettings,
  IconMenu2, IconX, IconLogout,
} from '@tabler/icons-react'
import { useAuth } from '../context/AuthContext'
import { useShop } from '../context/ShopContext'

// Grouped sidebar + topbar owner shell (SPEC §10.4). Simple on top: few groups,
// big labels, one register feel. Mobile collapses the sidebar into a drawer.
const NAV = [
  {
    group: 'Overview',
    items: [{ to: '/owner', end: true, label: 'Dashboard', icon: IconLayoutDashboard }],
  },
  {
    group: 'Stock',
    items: [
      { to: '/owner/purchase', label: 'Purchase Entry', icon: IconShoppingCartPlus },
      { to: '/owner/inventory', label: 'Inventory', icon: IconBoxSeam },
      { to: '/owner/stock', label: 'Stock Inquiry', icon: IconClipboardList },
    ],
  },
  {
    group: 'Selling',
    items: [
      { to: '/owner/orders', label: 'Orders', icon: IconReceipt2 },
      { to: '/owner/sales', label: 'Sales', icon: IconCoin },
    ],
  },
  {
    group: 'Money',
    items: [
      { to: '/owner/payments', label: 'Payments', icon: IconCash },
      { to: '/owner/parties', label: 'Parties', icon: IconUsers },
    ],
  },
  {
    group: 'Books',
    items: [
      { to: '/owner/reports', label: 'Reports', icon: IconChartBar },
      { to: '/owner/settings', label: 'Settings', icon: IconSettings },
    ],
  },
]

const TITLES = {
  '/owner': 'Dashboard',
  '/owner/purchase': 'Purchase Entry',
  '/owner/inventory': 'Inventory',
  '/owner/stock': 'Stock Inquiry',
  '/owner/orders': 'Orders',
  '/owner/sales': 'Sales',
  '/owner/payments': 'Payments',
  '/owner/parties': 'Parties',
  '/owner/reports': 'Reports',
  '/owner/settings': 'Settings',
}

export default function OwnerLayout() {
  const { profile, signOut } = useAuth()
  const { shop } = useShop()
  const { pathname } = useLocation()
  const [open, setOpen] = useState(false)

  const title =
    TITLES[pathname] ||
    Object.entries(TITLES)
      .filter(([p]) => p !== '/owner' && pathname.startsWith(p))
      .map(([, t]) => t)[0] ||
    'Owner'

  return (
    <div className="min-h-screen md:grid md:grid-cols-[16rem_1fr]">
      {/* ---- Sidebar ---- */}
      <Sidebar shop={shop} open={open} onClose={() => setOpen(false)} />

      {/* ---- Main column ---- */}
      <div className="flex min-h-screen flex-col">
        <header className="sticky top-0 z-20 flex items-center justify-between border-b border-line bg-card/90 px-4 py-3 backdrop-blur sm:px-6">
          <div className="flex items-center gap-3">
            <button
              className="rounded-lg p-1.5 text-muted hover:bg-paper-2 md:hidden"
              onClick={() => setOpen(true)}
              aria-label="Open menu"
            >
              <IconMenu2 size={22} />
            </button>
            <h1 className="font-[var(--font-display)] text-xl font-bold">{title}</h1>
          </div>

          <div className="flex items-center gap-3">
            <div className="hidden text-right sm:block">
              <p className="text-sm font-medium leading-tight">{profile?.full_name || 'Owner'}</p>
              <p className="text-xs capitalize text-muted">{profile?.role}</p>
            </div>
            <button
              onClick={signOut}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-card px-3 py-2 text-sm font-medium text-muted hover:text-ink"
            >
              <IconLogout size={18} /> <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-6 lg:p-8">
          <Outlet />
        </main>
      </div>
    </div>
  )
}

function Sidebar({ shop, open, onClose }) {
  return (
    <>
      {/* mobile backdrop */}
      {open && (
        <div className="fixed inset-0 z-30 bg-ink/30 md:hidden" onClick={onClose} />
      )}
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-64 transform border-r border-line bg-paper-2 transition-transform md:static md:translate-x-0 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between px-5 py-4">
          <span className="shop-stamp text-[10px] font-bold">
            {shop?.name?.split(' ').slice(0, 2).join(' ') || 'Shop'}
          </span>
          <button className="rounded-lg p-1 text-muted hover:bg-paper md:hidden" onClick={onClose} aria-label="Close menu">
            <IconX size={20} />
          </button>
        </div>

        <nav className="space-y-5 px-3 py-2">
          {NAV.map((sec) => (
            <div key={sec.group}>
              <p className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
                {sec.group}
              </p>
              <ul className="space-y-0.5">
                {sec.items.map((it) => (
                  <li key={it.to}>
                    <NavLink
                      to={it.to}
                      end={it.end}
                      onClick={onClose}
                      className={({ isActive }) =>
                        `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${
                          isActive
                            ? 'bg-peacock text-white shadow-sm'
                            : 'text-ink/80 hover:bg-paper hover:text-ink'
                        }`
                      }
                    >
                      <it.icon size={19} stroke={1.7} />
                      {it.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </aside>
    </>
  )
}
