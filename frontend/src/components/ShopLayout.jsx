import { Link, NavLink, Outlet } from 'react-router-dom'
import {
  IconReceipt2, IconUserCircle, IconLogin2, IconLogout, IconLayoutDashboard,
  IconClipboardCheck, IconBrandWhatsapp, IconBrandInstagram, IconBrandFacebook,
  IconBrandYoutube, IconMapPin, IconShoppingCart,
} from '@tabler/icons-react'
import { useAuth } from '../context/AuthContext'
import { useShop } from '../context/ShopContext'
import { useCart } from '../context/CartContext'
import { money } from '../lib/format'
import Credit from './Credit'
import Brand from './Brand'
import InstallButton from './InstallButton'

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
  // Owner/staff preview the shopfront but don't order — the cart is for buyers
  // and anonymous browsers (who can build a cart, then sign in to check out).
  const showCart = role !== 'owner' && role !== 'staff'

  return (
    <div className="min-h-screen bg-paper">
      <header className="sticky top-0 z-20 border-b border-line bg-card">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <Link to="/" className="shrink-0">
            <Brand shop={shop} maxWords={3} textClassName="text-[10px] sm:text-xs" logoClassName="h-9 sm:h-10" />
          </Link>

          <nav className="flex items-center gap-1 sm:gap-2">
            <InstallButton className="mr-1" />

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

            {showCart && (
              <Link
                to="/cart"
                aria-label="Cart"
                className="relative inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-ink/80 hover:bg-paper-2"
              >
                <IconShoppingCart size={19} stroke={1.7} />
                <span className="hidden sm:inline">Cart</span>
                {count > 0 && (
                  <span className="fig absolute -right-0.5 -top-0.5 grid h-5 min-w-[1.25rem] place-items-center rounded-full bg-saffron px-1 text-[11px] font-bold text-white">
                    {count}
                  </span>
                )}
              </Link>
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

      <Footer shop={shop} />
    </div>
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
            <nav className="flex flex-wrap justify-center gap-x-5 gap-y-2 text-sm">
              {pages.map((p) => (
                <Link key={p.to} to={p.to} className="text-ink/70 hover:text-peacock">{p.label}</Link>
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
                  className="grid h-9 w-9 place-items-center rounded-full border border-line text-muted transition hover:border-peacock hover:text-peacock"
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
