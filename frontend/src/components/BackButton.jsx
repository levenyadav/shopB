import { useLocation, useNavigate } from 'react-router-dom'
import { IconChevronLeft, IconArrowLeft } from '@tabler/icons-react'

// Where "back" goes from each inner page when there is NO history to go back to
// — a WhatsApp order link opened cold, a bookmark, a hard refresh. Ordered:
// first match wins, so put the deeper patterns above the catch-alls. A page
// missing from this list is treated as a root — no back button.
//
// The third entry is what the text control says when it falls back here. It
// names the destination, because on a cold open "Back" would be a lie: there is
// nothing behind this page (SPEC §3 — no dead ends).
const PARENTS = [
  // Shopfront + buyer area
  [/^\/item\/[^/]+$/,                     '/',                'Back to shop'],
  [/^\/cart$/,                            '/',                'Continue shopping'],
  [/^\/shop\/[^/]+$/,                     '/',                'Back to shop'],
  [/^\/(about|contact|privacy|terms)$/,   '/',                'Back to shop'],
  [/^\/orders\/[^/]+$/,                   '/orders',          'My orders'],
  [/^\/(orders|account)$/,                '/',                'Back to shop'],
  // Owner console — detail pages return to their list, everything else to Dashboard
  [/^\/owner\/orders\/[^/]+$/,            '/owner/orders',    'All orders'],
  [/^\/owner\/sales\/[^/]+$/,             '/owner/sales',     'All sales'],
  [/^\/owner\/purchases\/[^/]+$/,         '/owner/purchases', 'Purchase history'],
  [/^\/owner\/fulfilment\/[^/]+$/,        '/owner/fulfilment','All fulfilment'],
  [/^\/owner\/parties\/[^/]+\/[^/]+$/,    '/owner/parties',   'All parties'],
  [/^\/owner\/.+$/,                       '/owner',           'Dashboard'],
  // Staff console
  [/^\/staff\/fulfil\/[^/]+$/,            '/staff',           'All fulfilment'],
  [/^\/staff\/.+$/,                       '/staff',           'Fulfilment'],
]

export function parentPath(pathname) {
  const hit = PARENTS.find(([re]) => re.test(pathname))
  return hit ? hit[1] : null
}

// One rule for every back control on the site.
//
// A deep page is reachable from several places — a sale opens from Sales, from
// a party's bill list, from the dashboard — so sending everyone to the same
// list strands whoever did not come from it. Go back to the screen they were
// actually on.
//
// But history is not always there: order links get sent on WhatsApp, so a page
// is often the FIRST entry in the tab's history, and back() there dumps the
// buyer out of the shop entirely. React Router marks that first entry with
// key === 'default', which is exactly the case where we use the parent map.
export function useBack() {
  const { pathname, key } = useLocation()
  const navigate = useNavigate()
  const hit = PARENTS.find(([re]) => re.test(pathname))
  const canGoBack = key !== 'default'
  return {
    // A section root (the shopfront, the Dashboard, the fulfilment board) has
    // nothing above it, so it shows no back control even when history exists —
    // the nav is how you move between sections.
    isRoot: !hit,
    canGoBack,
    to: hit ? hit[1] : null,
    label: canGoBack ? 'Back' : (hit ? hit[2] : 'Back'),
    goBack: () => (canGoBack ? navigate(-1) : navigate(hit ? hit[1] : '/')),
  }
}

// Back arrow in the layout header. Shown at every width: the sidebar tells you
// where you ARE, it does not take you back to where you came from.
export default function BackButton({ label = 'Back' }) {
  const { isRoot, goBack } = useBack()
  if (isRoot) return null

  return (
    <button
      type="button"
      onClick={goBack}
      aria-label={label}
      className="-ml-1.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg text-ink/80 hover:bg-paper-2"
    >
      <IconChevronLeft size={24} stroke={1.8} />
    </button>
  )
}

// The text control at the top of an inner page ("← Back"). Same behaviour as
// the header arrow; `className` carries page-specific needs such as no-print.
export function BackLink({ className = '' }) {
  const { isRoot, goBack, label } = useBack()
  if (isRoot) return null

  return (
    <button
      type="button"
      onClick={goBack}
      className={`inline-flex items-center gap-1.5 text-sm font-medium text-muted transition hover:text-ink ${className}`}
    >
      <IconArrowLeft size={17} /> {label}
    </button>
  )
}
