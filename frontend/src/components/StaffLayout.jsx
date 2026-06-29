import { Outlet, Link } from 'react-router-dom'
import { IconBuildingStore, IconLogout, IconClipboardCheck } from '@tabler/icons-react'
import { useAuth } from '../context/AuthContext'
import { useShop } from '../context/ShopContext'

// SPEC §10.3 — Staff console. Staff exist to fulfil orders, so the shell is
// single-purpose: the packing board is home. (Purchase/Stock for staff come with
// their own routes in a later pass — they need the owner pages' links rerouted.)
export default function StaffLayout() {
  const { profile, signOut } = useAuth()
  const { shop } = useShop()

  return (
    <div className="min-h-screen bg-paper">
      <header className="no-print sticky top-0 z-20 border-b border-line bg-card/90 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <Link to="/staff" className="flex items-center gap-2">
            <span className="shop-stamp text-[10px] font-bold">
              {shop?.name?.split(' ').slice(0, 2).join(' ') || 'Shop'}
            </span>
          </Link>

          <div className="flex items-center gap-1 text-sm font-medium text-peacock">
            <IconClipboardCheck size={19} stroke={1.7} /> Fulfilment
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
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
        <div className="no-print mb-5">
          <h1 className="font-[var(--font-display)] text-2xl font-bold">Fulfilment</h1>
          <p className="text-sm text-muted">
            {profile?.full_name ? `${profile.full_name.split(' ')[0]}, p` : 'P'}ack approved orders and mark them out.
          </p>
        </div>
        <Outlet />
      </main>
    </div>
  )
}
