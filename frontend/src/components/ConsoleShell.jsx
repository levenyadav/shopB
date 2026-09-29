import { useEffect, useState, Suspense } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigationType } from 'react-router-dom'
import { IconDots, IconX, IconLogout, IconBuildingStore } from '@tabler/icons-react'
import { useAuth } from '../context/AuthContext'
import { useShop } from '../context/ShopContext'
import Brand from './Brand'
import BackButton from './BackButton'

// One shell for both consoles (owner + staff), so they read as one register.
//
//   desktop → sidebar (grouped nav, who's signed in, View shop, Sign out) + a
//             slim top bar with the page title.
//   phone   → top bar with the title, and a bottom tab bar holding the few
//             screens used all day; "More" opens the full menu.
//
// Props:
//   home    — the console root ('/owner' | '/staff')
//   groups  — [{ group?, items: [{ to, label, icon, end? }] }]
//   tabs    — up to 4 `to` paths for the phone tab bar (plus More if the menu
//             has anything else)
//   titles  — { path: title } for the top bar; longest matching prefix wins
//   badges  — { path: count } — a live count on a nav item (pending orders)
export default function ConsoleShell({ home, groups, tabs, titles, badges = {} }) {
  const { profile, signOut } = useAuth()
  const { shop } = useShop()
  const { pathname } = useLocation()
  const [menuOpen, setMenuOpen] = useState(false)
  const navType = useNavigationType()
  useEffect(() => {
    setMenuOpen(false)
    // A new screen starts at the top; Back/forward keeps the browser's place.
    if (navType !== 'POP') window.scrollTo(0, 0)
  }, [pathname]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!menuOpen) return
    const onKey = (e) => { if (e.key === 'Escape') setMenuOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menuOpen])

  const all = groups.flatMap((g) => g.items)
  const tabItems = tabs.map((t) => all.find((i) => i.to === t)).filter(Boolean)
  const hasMore = all.length > tabItems.length

  const title =
    titles[pathname] ||
    Object.entries(titles)
      .filter(([p]) => p !== home && pathname.startsWith(p))
      .sort((a, b) => b[0].length - a[0].length)
      .map(([, t]) => t)[0] ||
    titles[home]

  const menu = (
    <Menu
      shop={shop} home={home} groups={groups} badges={badges}
      profile={profile} signOut={signOut}
    />
  )

  return (
    <div className="console min-h-screen bg-paper md:grid md:grid-cols-[15rem_1fr]">
      {/* Desktop sidebar */}
      <aside className="no-print sticky top-0 hidden h-screen flex-col border-r border-line bg-card md:flex">
        {menu}
      </aside>

      {/* Phone menu — only in the DOM while open, so its links are never
          tabbable off-screen. */}
      {menuOpen && (
        <div className="no-print fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="absolute inset-0 bg-ink/30" onClick={() => setMenuOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-card shadow-xl">
            <button
              type="button" onClick={() => setMenuOpen(false)} aria-label="Close menu" autoFocus
              className="absolute right-2 top-3 grid h-11 w-11 place-items-center rounded-lg text-muted hover:bg-paper-2 hover:text-ink"
            >
              <IconX size={20} />
            </button>
            {menu}
          </aside>
        </div>
      )}

      <div className="flex min-h-screen min-w-0 flex-col">
        <header className="no-print sticky top-0 z-20 flex h-14 items-center gap-1 border-b border-line bg-card px-3 sm:px-6">
          <BackButton />
          <h1 className="truncate font-[var(--font-display)] text-lg font-bold text-ink sm:text-xl">{title}</h1>
        </header>

        <main className="flex-1 px-4 pb-24 pt-5 sm:px-6 md:pb-8 lg:px-8">
          {/* Pages load on demand (App.jsx) — keep the shell up meanwhile. */}
          <Suspense fallback={null}><Outlet /></Suspense>
        </main>
      </div>

      {/* Phone tab bar */}
      <nav
        aria-label="Main"
        className="no-print fixed inset-x-0 bottom-0 z-30 grid border-t border-line bg-card pb-[env(safe-area-inset-bottom)] md:hidden"
        style={{ gridTemplateColumns: `repeat(${tabItems.length + (hasMore ? 1 : 0)}, minmax(0, 1fr))` }}
      >
        {tabItems.map((it) => (
          <NavLink
            key={it.to} to={it.to} end={it.end}
            className={({ isActive }) =>
              `relative flex h-16 flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors duration-150 ${
                isActive ? 'text-peacock' : 'text-muted hover:text-ink'
              }`
            }
          >
            <it.icon size={22} stroke={1.7} aria-hidden />
            <span className="truncate">{it.short || it.label}</span>
            <Count n={badges[it.to]} className="absolute left-1/2 top-2 ml-2" />
          </NavLink>
        ))}
        {hasMore && (
          <button
            type="button" onClick={() => setMenuOpen(true)} aria-haspopup="dialog"
            className="flex h-16 flex-col items-center justify-center gap-0.5 text-[11px] font-medium text-muted hover:text-ink"
          >
            <IconDots size={22} stroke={1.7} aria-hidden />
            More
          </button>
        )}
      </nav>
    </div>
  )
}

function Menu({ shop, home, groups, badges, profile, signOut }) {
  return (
    <>
      <div className="flex min-h-16 shrink-0 items-center px-5 py-3">
        <Link to={home} aria-label="Console home" className="flex min-h-11 items-center">
          <Brand shop={shop} maxWords={2} textClassName="text-[10px]" logoClassName="h-8" />
        </Link>
      </div>

      <nav aria-label="Console" className="flex-1 space-y-5 overflow-y-auto px-3 py-3">
        {groups.map((sec, i) => (
          <div key={sec.group || i}>
            {sec.group && (
              <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">{sec.group}</p>
            )}
            <ul className="space-y-0.5">
              {sec.items.map((it) => (
                <li key={it.to}>
                  <NavLink
                    to={it.to} end={it.end}
                    className={({ isActive }) =>
                      `relative flex min-h-10 items-center gap-3 rounded-lg px-3 text-sm transition-colors duration-150 ${
                        isActive
                          ? 'bg-paper-2 font-semibold text-ink before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-peacock'
                          : 'font-medium text-ink/70 hover:bg-paper-2 hover:text-ink'
                      }`
                    }
                  >
                    {({ isActive }) => (
                      <>
                        <it.icon size={19} stroke={1.7} className={isActive ? 'text-peacock' : 'text-muted'} aria-hidden />
                        <span className="flex-1">{it.label}</span>
                        <Count n={badges[it.to]} />
                      </>
                    )}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <div className="shrink-0 border-t border-line p-3">
        <div className="px-3 pb-2">
          <p className="truncate text-sm font-medium text-ink">{profile?.full_name || 'Signed in'}</p>
          <p className="text-xs capitalize text-muted">{profile?.role}</p>
        </div>
        <Link to="/" className="flex min-h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium text-ink/70 hover:bg-paper-2 hover:text-ink">
          <IconBuildingStore size={19} stroke={1.7} className="text-muted" aria-hidden /> View shop
        </Link>
        <button type="button" onClick={signOut} className="flex min-h-10 w-full items-center gap-3 rounded-lg px-3 text-sm font-medium text-ink/70 hover:bg-paper-2 hover:text-ink">
          <IconLogout size={19} stroke={1.7} className="text-muted" aria-hidden /> Sign out
        </button>
      </div>
    </>
  )
}

function Count({ n, className = '' }) {
  if (!(n > 0)) return null
  return (
    <span className={`fig grid h-5 min-w-5 place-items-center rounded-full bg-saffron px-1.5 text-[11px] font-bold text-white ${className}`}>
      {n > 99 ? '99+' : n}
    </span>
  )
}
