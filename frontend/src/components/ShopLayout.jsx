import { Link, NavLink, Outlet } from 'react-router-dom'
import {
  IconReceipt2, IconUserCircle, IconLogin2, IconLogout, IconLayoutDashboard,
  IconClipboardCheck,
} from '@tabler/icons-react'
import { useAuth } from '../context/AuthContext'
import { useShop } from '../context/ShopContext'
import { money } from '../lib/format'
import Credit from './Credit'

// Public shopfront shell (SPEC §10.1–§10.2). The header adapts to who's looking:
//   not signed in  → Sign in
//   customer/dealer → My Orders · Account (with running balance) · Sign out
//   owner/staff     → link back to their console · Sign out
// No login is required just to browse — only to place an order.
export default function ShopLayout() {
  const { profile, role, signOut } = useAuth()
  const { shop } = useShop()

  return (
    <div className="min-h-screen bg-paper">
      <header className="sticky top-0 z-20 border-b border-line bg-card">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <Link to="/" className="shrink-0">
            <span className="shop-stamp text-[10px] font-bold sm:text-xs">
              {shop?.name?.split(' ').slice(0, 3).join(' ') || 'Shop'}
            </span>
          </Link>

          <nav className="flex items-center gap-1 sm:gap-2">
            {role === 'owner' && (
              <HeaderLink to="/owner" icon={IconLayoutDashboard} label="Owner console" />
            )}

            {role === 'staff' && (
              <HeaderLink to="/staff" icon={IconClipboardCheck} label="Fulfilment" />
            )}

            {(role === 'customer' || role === 'dealer') && (
              <>
                <HeaderLink to="/orders" icon={IconReceipt2} label="My Orders" />
                <Link
                  to="/account"
                  className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-ink/80 hover:bg-paper-2"
                >
                  <IconUserCircle size={19} stroke={1.7} />
                  <span className="hidden sm:flex sm:flex-col sm:items-start sm:leading-tight">
                    <span>{profile?.full_name?.split(' ')[0] || 'Account'}</span>
                    {Number(profile?.balance_due) > 0 && (
                      <span className="fig text-[11px] text-dues">
                        Udhaar {money(profile.balance_due)}
                      </span>
                    )}
                  </span>
                </Link>
              </>
            )}

            {profile ? (
              <button
                onClick={signOut}
                className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-card px-3 py-2 text-sm font-medium text-muted hover:text-ink"
              >
                <IconLogout size={18} /> <span className="hidden sm:inline">Sign out</span>
              </button>
            ) : (
              <Link
                to="/login"
                className="inline-flex items-center gap-1.5 rounded-lg bg-peacock px-4 py-2 text-sm font-semibold text-white hover:bg-peacock-700"
              >
                <IconLogin2 size={18} /> Sign in
              </Link>
            )}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
        <Outlet />
      </main>

      <footer className="border-t border-line py-6 text-center text-xs text-muted space-y-1">
        <div>{shop?.name || 'Shop'} · {shop?.phone || ''}</div>
        <Credit />
      </footer>
    </div>
  )
}

function HeaderLink({ to, icon: Icon, label }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition ${
          isActive ? 'bg-peacock/10 text-peacock' : 'text-ink/80 hover:bg-paper-2'
        }`
      }
    >
      <Icon size={19} stroke={1.7} /> <span className="hidden sm:inline">{label}</span>
    </NavLink>
  )
}
