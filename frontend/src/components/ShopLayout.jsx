import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import {
  IconReceipt2, IconUserCircle, IconLogin2, IconLogout, IconLayoutDashboard,
  IconClipboardCheck, IconBrandWhatsapp, IconBrandInstagram, IconBrandFacebook,
  IconBrandYoutube, IconMapPin, IconShoppingCart, IconMenu2, IconX, IconHome,
} from '@tabler/icons-react'
import { useAuth } from '../context/AuthContext'
import { useShop } from '../context/ShopContext'
import { useCart } from '../context/CartContext'
import { money } from '../lib/format'
import Credit from './Credit'
import Brand from './Brand'
import InstallButton from './InstallButton'
import BackButton from './BackButton'

// Social icons shown in the footer — only those the owner filled in (Settings).
// WhatsApp may be a bare number; normalise it to a wa.me link.
const SOCIAL_ICONS = [
  { key: 'whatsapp',  icon: IconBrandWhatsapp,  label: 'WhatsApp',
    href: (v) => (/^https?:\/\//.test(v) ? v : `https://wa.me/${v.replace(/[^\d]/g, '')}`) },
  { key: 'instagram', icon: IconBrandInstagram, label: 'Instagram', href: (v) => v },
  { key: 'facebook',  icon: IconBrandFacebook,  label: 'Facebook',  href: (v) => v },
  { key: 'youtube',   icon: IconBrandYoutube,   label: 'YouTube',   href: (v) => v },
  { key: 'map_url',   icon: IconMapPin,         label: 'Location',  href: (v) => v },
]

// Footer page links — only shown when the owner has written that page.
const FOOTER_PAGES = [
  { to: '/about',   col: 'about_us',       label: 'About Us' },
  { to: '/contact', col: 'contact_info',   label: 'Contact' },
  { to: '/privacy', col: 'privacy_policy', label: 'Privacy Policy' },
  { to: '/terms',   col: 'terms',          label: 'Terms' },
]

// Public shopfront shell (SPEC §10.1–§10.2). The header adapts to who's looking:
//   not signed in  → Sign in
//   customer/dealer → My Orders · Account (with running balance) · Sign out
//   owner/staff     → link back to their console · Sign out
// No login is required just to browse — only to place an order.
export default function ShopLayout() {
  const { profile, role, signOut } = useAuth()
  const { shop } = useShop()
  const { count } = useCart()
  const { pathname } = useLocation()
  const [menuOpen, setMenuOpen] = useState(false)
  // Owner/staff preview the shopfront but don't order — the cart is for buyers
  // and anonymous browsers (who can build a cart, then sign in to check out).
  const showCart = role !== 'owner' && role !== 'staff'

  // A shopfront needs its full width for the product grid, so the menu is a
  // drawer at every size rather than a permanent sidebar. Only the logo and the
  // cart stay in the header — the two things a buyer reaches for mid-browse.
  useEffect(() => { setMenuOpen(false) }, [pathname])

  return (
    <div className="min-h-screen bg-paper">
      <header className="sticky top-0 z-20 border-b border-line bg-card">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-2 px-3 py-2.5 sm:gap-3 sm:px-6 sm:py-3">
          <div className="flex min-w-0 items-center gap-1">
            <BackButton />
            <Link to="/" className="min-w-0 shrink">
              <Brand shop={shop} maxWords={3} textClassName="text-[10px] sm:text-xs" logoClassName="h-8 sm:h-10" />
            </Link>
          </div>

          <nav className="flex shrink-0 items-center gap-1 sm:gap-2">
            {showCart && (
              <Link
                to="/cart"
                aria-label={`Cart${count > 0 ? `, ${count} item${count === 1 ? '' : 's'}` : ''}`}
                className="relative inline-flex h-11 items-center gap-2 rounded-lg px-2.5 text-sm font-medium text-ink/80 hover:bg-paper-2 sm:px-3"
              >
                <IconShoppingCart size={22} stroke={1.7} />
                <span className="hidden sm:inline">Cart</span>
                {count > 0 && (
                  <span className="fig absolute right-0 top-1 grid h-5 min-w-[1.25rem] place-items-center rounded-full bg-saffron px-1 text-[11px] font-bold text-white">
                    {count}
                  </span>
                )}
              </Link>
            )}

            <button
              onClick={() => setMenuOpen(true)}
              aria-label="Open menu"
              className="inline-flex h-11 items-center gap-2 rounded-lg border border-line px-2.5 text-sm font-medium text-ink/80 hover:bg-paper-2 sm:px-3"
            >
              <IconMenu2 size={22} stroke={1.7} />
              <span className="hidden sm:inline">Menu</span>
            </button>
          </nav>
        </div>
      </header>

      <MenuDrawer
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        shop={shop}
        profile={profile}
        role={role}
        signOut={signOut}
      />

      <main className="mx-auto max-w-6xl px-4 py-5 sm:px-6 sm:py-8">
        <Outlet />
      </main>

      <Footer shop={shop} />
    </div>
  )
}

// Slide-in menu. Holds everything that used to crowd the header: the buyer's
// orders and account (with running udhaar), the owner/staff link back to their
// console, and sign in / sign out.
function MenuDrawer({ open, onClose, shop, profile, role, signOut }) {
  // Don't let the page scroll behind an open drawer.
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [open])

  // Escape closes it — the drawer covers the screen on a phone.
  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const isBuyer = role === 'customer' || role === 'dealer'

  return (
    <>
      <div
        className={`fixed inset-0 z-40 bg-ink/40 transition-opacity ${
          open ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
        onClick={onClose}
      />
      <aside
        aria-hidden={!open}
        className={`fixed inset-y-0 right-0 z-50 flex w-[85vw] max-w-xs transform flex-col border-l border-line bg-card transition-transform duration-200 ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <Brand shop={shop} maxWords={3} textClassName="text-[10px]" logoClassName="h-8" />
          <button
            onClick={onClose}
            aria-label="Close menu"
            className="grid h-10 w-10 place-items-center rounded-lg text-muted hover:bg-paper-2 hover:text-ink"
          >
            <IconX size={22} />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto p-3">
          <ul className="space-y-1">
            <li><DrawerLink to="/" end icon={IconHome} label="Shop" /></li>

            {role === 'owner' && (
              <li><DrawerLink to="/owner" icon={IconLayoutDashboard} label="Owner console" /></li>
            )}
            {role === 'staff' && (
              <li><DrawerLink to="/staff" icon={IconClipboardCheck} label="Fulfilment" /></li>
            )}

            {isBuyer && (
              <>
                <li><DrawerLink to="/orders" icon={IconReceipt2} label="My Orders" /></li>
                <li>
                  <DrawerLink
                    to="/account"
                    icon={IconUserCircle}
                    label={profile?.full_name?.split(' ')[0] || 'Account'}
                    note={
                      Number(profile?.balance_due) > 0
                        ? `Udhaar ${money(profile.balance_due)}`
                        : null
                    }
                  />
                </li>
              </>
            )}
          </ul>
        </nav>

        <div className="space-y-2 border-t border-line p-3">
          {/* Renders nothing on desktop or once installed — no empty gap. */}
          <InstallButton className="h-11 w-full justify-center" />

          {profile ? (
            <button
              onClick={signOut}
              className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-line bg-card text-sm font-medium text-muted hover:text-ink"
            >
              <IconLogout size={18} /> Sign out
            </button>
          ) : (
            <Link
              to="/login"
              className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-peacock text-sm font-semibold text-white hover:bg-peacock-700"
            >
              <IconLogin2 size={18} /> Sign in / Register
            </Link>
          )}
        </div>
      </aside>
    </>
  )
}

function DrawerLink({ to, end, icon: Icon, label, note }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `flex min-h-11 items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${
          isActive
            ? 'bg-peacock/10 font-semibold text-peacock'
            : 'font-medium text-ink/80 hover:bg-paper-2 hover:text-ink'
        }`
      }
    >
      <Icon size={20} stroke={1.7} />
      <span className="flex flex-1 flex-col items-start leading-tight">
        <span>{label}</span>
        {note && <span className="fig text-[11px] text-dues">{note}</span>}
      </span>
    </NavLink>
  )
}

function Footer({ shop }) {
  const socials = SOCIAL_ICONS.filter((s) => shop?.[s.key]?.trim())
  const pages = FOOTER_PAGES.filter((p) => shop?.[p.col]?.trim())

  return (
    <footer className="mt-8 border-t border-line bg-card">
      <div className="mx-auto max-w-6xl space-y-5 px-4 py-8 sm:px-6">
        <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-start sm:justify-between">
          {/* Shop identity */}
          <div className="text-center sm:text-left">
            <Brand shop={shop} maxWords={3} textClassName="text-sm" logoClassName="h-9" />
            <p className="mt-2 text-xs text-muted">
              {shop?.address || ''}
              {shop?.phone && <><br />{shop.phone}</>}
            </p>
          </div>

          {/* Page links */}
          {pages.length > 0 && (
            <nav className="flex flex-wrap justify-center gap-x-5 gap-y-1 text-sm">
              {pages.map((p) => (
                <Link key={p.to} to={p.to} className="inline-flex min-h-11 items-center text-ink/70 hover:text-peacock">
                  {p.label}
                </Link>
              ))}
            </nav>
          )}

          {/* Social icons */}
          {socials.length > 0 && (
            <div className="flex items-center gap-2">
              {socials.map((s) => (
                <a
                  key={s.key}
                  href={s.href(shop[s.key].trim())}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={s.label}
                  title={s.label}
                  className="grid h-11 w-11 place-items-center rounded-full border border-line text-muted transition hover:border-peacock hover:text-peacock"
                >
                  <s.icon size={18} stroke={1.7} />
                </a>
              ))}
            </div>
          )}
        </div>

        <div className="border-t border-line pt-4 text-center text-xs text-muted">
          <Credit />
        </div>
      </div>
    </footer>
  )
}
