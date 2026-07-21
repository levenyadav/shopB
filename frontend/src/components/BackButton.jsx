import { Link, useLocation } from 'react-router-dom'
import { IconChevronLeft } from '@tabler/icons-react'

// Where "back" goes from each inner page. Ordered: first match wins, so put the
// deeper patterns above the catch-alls. A page missing from this list is treated
// as a root — no back button.
//
// We navigate to a known parent instead of history.back(). Order links get sent
// on WhatsApp, so a page is often the FIRST entry in the tab's history; back()
// there dumps the buyer out of the shop entirely (SPEC §3 — no dead ends).
const PARENTS = [
  // Shopfront + buyer area
  [/^\/item\/[^/]+$/,                     '/'],
  [/^\/cart$/,                            '/'],
  [/^\/shop\/[^/]+$/,                     '/'],
  [/^\/(about|contact|privacy|terms)$/,   '/'],
  [/^\/orders\/[^/]+$/,                   '/orders'],
  [/^\/(orders|account)$/,                '/'],
  // Owner console — detail pages return to their list, everything else to Dashboard
  [/^\/owner\/orders\/[^/]+$/,            '/owner/orders'],
  [/^\/owner\/sales\/[^/]+$/,             '/owner/sales'],
  [/^\/owner\/fulfilment\/[^/]+$/,        '/owner/fulfilment'],
  [/^\/owner\/parties\/[^/]+\/[^/]+$/,    '/owner/parties'],
  [/^\/owner\/.+$/,                       '/owner'],
  // Staff console
  [/^\/staff\/fulfil\/[^/]+$/,            '/staff'],
  [/^\/staff\/.+$/,                       '/staff'],
]

export function parentPath(pathname) {
  const hit = PARENTS.find(([re]) => re.test(pathname))
  return hit ? hit[1] : null
}

// Back arrow for the header on small screens, where the sidebar/nav is collapsed
// and an inner page has no visible way up. Renders nothing on a section root
// (shopfront, Dashboard, Fulfilment board) — there is nothing above it.
//
// hideAt: the breakpoint at which the layout's own navigation reappears and the
// arrow becomes redundant ('sm' for the shopfront/staff tabs, 'md' for the owner
// sidebar, matching that layout's hamburger).
export default function BackButton({ hideAt = 'sm', label = 'Back' }) {
  const { pathname } = useLocation()
  const to = parentPath(pathname)
  if (!to) return null

  return (
    <Link
      to={to}
      aria-label={label}
      className={`-ml-1.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg text-ink/80 hover:bg-paper-2 ${
        hideAt === 'md' ? 'md:hidden' : 'sm:hidden'
      }`}
    >
      <IconChevronLeft size={24} stroke={1.8} />
    </Link>
  )
}
