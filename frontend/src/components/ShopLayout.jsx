import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate, useNavigationType, useSearchParams } from 'react-router-dom'
import {
  IconReceipt2, IconUserCircle, IconUser, IconLayoutDashboard, IconClipboardCheck,
  IconBrandWhatsapp, IconBrandInstagram, IconBrandFacebook, IconBrandYoutube,
  IconMapPin, IconShoppingBag, IconSearch, IconX, IconCircleCheck,
} from '@tabler/icons-react'
import { useAuth } from '../context/AuthContext'
import { useShop } from '../context/ShopContext'
import { useCart } from '../context/CartContext'
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

// The catalogue grid — home and a category. Search edits these pages' URL live.
export const isListing = (pathname) => pathname === '/' || pathname.startsWith('/shop/')
// Pages where the search box earns its space: the grid and a product.
const showsSearch = (pathname) => isListing(pathname) || pathname.startsWith('/item/')

// Public shopfront shell (SPEC §10.1–§10.2). One sticky header, no drawer:
//   phone   → [back] logo ········ orders · account · cart
//             [ search ······························ ]
//   desktop → logo · [ search ······ ] · Orders · Account · Cart
// Owner/staff get a link back to their console instead of Orders/Account/Cart.
// No login is required just to browse — only to place an order.
export default function ShopLayout() {
  const { role } = useAuth()
  const { shop } = useShop()
  const { distinctCount } = useCart()
  const { pathname } = useLocation()
  const isBuyer = role === 'customer' || role === 'dealer'
  const isStaffSide = role === 'owner' || role === 'staff'
  const search = showsSearch(pathname)
  const navType = useNavigationType()

  // A new page starts at the top. Back/forward (POP) is left alone — the
  // shopfront grid restores its own saved position.
  useEffect(() => {
    if (navType !== 'POP') window.scrollTo(0, 0)
  }, [pathname]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="storefront flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 border-b border-line bg-card">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-2 gap-y-2 px-4 py-2 sm:flex-nowrap sm:gap-x-4 sm:px-6">
          <div className="flex min-w-0 flex-1 items-center gap-1 sm:flex-none">
            <BackButton />
            <Link to="/" className="flex min-h-11 min-w-0 items-center" aria-label={`${shop?.name || 'Shop'} — home`}>
              <Brand shop={shop} maxWords={3} logoClassName="h-8 sm:h-9" />
            </Link>
          </div>

          {search && <HeaderSearch className="order-last w-full sm:order-none sm:mx-auto sm:max-w-xl sm:flex-1" />}

          <nav aria-label="Account" className="flex shrink-0 items-center">
            {isStaffSide ? (
              <HeaderLink
                to={role === 'owner' ? '/owner' : '/staff'}
                icon={role === 'owner' ? IconLayoutDashboard : IconClipboardCheck}
                label={role === 'owner' ? 'Owner console' : 'Fulfilment'}
              />
            ) : (
              <>
                {isBuyer ? (
                  <>
                    <HeaderLink to="/orders" icon={IconReceipt2} label="Orders" />
                    <HeaderLink to="/account" icon={IconUserCircle} label="Account" />
                  </>
                ) : (
                  <HeaderLink to={`/login?next=${encodeURIComponent(pathname)}`} icon={IconUser} label="Sign in" />
                )}
                <HeaderLink
                  to="/cart"
                  icon={IconShoppingBag}
                  label="Cart"
                  ariaLabel={`Cart${distinctCount ? `, ${distinctCount} item${distinctCount === 1 ? '' : 's'}` : ''}`}
                  badge={distinctCount}
                />
              </>
            )}
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-4 sm:px-6 sm:py-6">
        <Outlet />
      </main>

      <Footer shop={shop} />
      {!isStaffSide && <AddedToast />}
    </div>
  )
}

// Icon + label (label from lg up; the icon alone on smaller screens, with the
// label kept for screen readers). 44px tall — a thumb-sized target.
function HeaderLink({ to, icon: Icon, label, ariaLabel, badge = 0 }) {
  return (
    <NavLink
      to={to}
      aria-label={ariaLabel || label}
      className={({ isActive }) =>
        `relative inline-flex h-11 min-w-11 items-center justify-center gap-2 rounded-lg px-2.5 text-sm font-medium transition-colors duration-150 hover:bg-paper-2 ${
          isActive ? 'text-peacock' : 'text-ink/80 hover:text-ink'
        }`
      }
    >
      <Icon size={22} stroke={1.6} aria-hidden />
      <span className="hidden lg:inline">{label}</span>
      {badge > 0 && (
        <span className="fig absolute right-0.5 top-1 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-ink px-1 text-[11px] font-semibold text-white lg:static lg:ml-0.5">
          {badge}
        </span>
      )}
    </NavLink>
  )
}

// One search box for the whole shop. On the grid it edits ?q= live (so Back from
// a product returns to the same results); on a product page, Enter searches the
// catalogue.
function HeaderSearch({ className = '' }) {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const onGrid = isListing(pathname)
  const [draft, setDraft] = useState('')
  const value = onGrid ? (params.get('q') || '') : draft

  function change(v) {
    if (!onGrid) { setDraft(v); return }
    setParams((p) => {
      const next = new URLSearchParams(p)
      if (v) next.set('q', v)
      else next.delete('q')
      return next
    }, { replace: true })
  }

  function submit(e) {
    e.preventDefault()
    e.currentTarget.querySelector('input')?.blur() // close the phone keyboard
    if (!onGrid) navigate(value.trim() ? `/?q=${encodeURIComponent(value.trim())}` : '/')
  }

  return (
    <form role="search" onSubmit={submit} className={`relative ${className}`}>
      <label htmlFor="shop-search" className="sr-only">Search products</label>
      <IconSearch size={18} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
      <input
        id="shop-search"
        type="search"
        enterKeyHint="search"
        autoComplete="off"
        value={value}
        onChange={(e) => change(e.target.value)}
        placeholder="Search cards, gifts, boxes…"
        className="h-11 w-full rounded-lg border border-transparent bg-paper-2 pl-10 pr-10 text-[15px] text-ink outline-none transition-colors duration-150 placeholder:text-muted focus:border-line focus:bg-card [&::-webkit-search-cancel-button]:hidden"
      />
      {value && (
        <button
          type="button"
          onClick={() => change('')}
          aria-label="Clear search"
          className="absolute right-0 top-0 grid h-11 w-11 place-items-center text-muted hover:text-ink"
        >
          <IconX size={18} />
        </button>
      )}
    </form>
  )
}

// "Added to cart" confirmation — one shared toast instead of each page swapping
// its own form for a success panel. Sits above the sticky purchase bars.
function AddedToast() {
  const { lastAdded, dismissAdded } = useCart()
  const { pathname } = useLocation()

  useEffect(() => {
    if (!lastAdded) return
    const t = setTimeout(dismissAdded, 2800)
    return () => clearTimeout(t)
  }, [lastAdded, dismissAdded])

  useEffect(() => { dismissAdded() }, [pathname, dismissAdded])

  return (
    <div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-24 z-40 flex justify-center px-4 md:bottom-6">
      {lastAdded && (
        <div className="pointer-events-auto flex max-w-md items-center gap-3 rounded-full bg-ink py-1.5 pl-4 pr-1.5 text-sm text-white shadow-lg">
          <IconCircleCheck size={18} className="shrink-0 text-white/80" aria-hidden />
          <span className="min-w-0 truncate">Added {lastAdded.name}</span>
          <Link to="/cart" className="inline-flex h-9 shrink-0 items-center rounded-full bg-white/15 px-3.5 font-semibold hover:bg-white/25">
            View cart
          </Link>
        </div>
      )}
    </div>
  )
}

function Footer({ shop }) {
  const socials = SOCIAL_ICONS.filter((s) => shop?.[s.key]?.trim())
  const pages = FOOTER_PAGES.filter((p) => shop?.[p.col]?.trim())

  return (
    <footer className="mt-10 border-t border-line bg-card">
      <div className="mx-auto max-w-7xl space-y-5 px-4 py-8 sm:px-6">
        <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-start sm:justify-between">
          {/* Shop identity */}
          <div className="text-center sm:text-left">
            <p className="font-[var(--font-display)] font-semibold text-ink">{shop?.name}</p>
            <p className="mt-1 text-sm text-muted">
              {shop?.address || ''}
              {shop?.phone && <><br /><a href={`tel:${shop.phone}`} className="hover:text-ink">{shop.phone}</a></>}
            </p>
          </div>

          {/* Page links */}
          {pages.length > 0 && (
            <nav aria-label="Shop information" className="flex flex-wrap justify-center gap-x-5 text-sm">
              {pages.map((p) => (
                <Link key={p.to} to={p.to} className="inline-flex min-h-11 items-center text-ink/70 hover:text-ink">
                  {p.label}
                </Link>
              ))}
            </nav>
          )}

          {/* Social icons */}
          {socials.length > 0 && (
            <div className="flex items-center gap-1">
              {socials.map((s) => (
                <a
                  key={s.key}
                  href={s.href(shop[s.key].trim())}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={s.label}
                  title={s.label}
                  className="grid h-11 w-11 place-items-center rounded-full text-muted transition-colors duration-150 hover:bg-paper-2 hover:text-ink"
                >
                  <s.icon size={20} stroke={1.6} />
                </a>
              ))}
            </div>
          )}
        </div>

        {/* Renders nothing on desktop or once installed. */}
        <div className="flex justify-center empty:hidden">
          <InstallButton className="h-11" />
        </div>

        <div className="border-t border-line pt-4 text-center">
          <Credit />
        </div>
      </div>
    </footer>
  )
}
