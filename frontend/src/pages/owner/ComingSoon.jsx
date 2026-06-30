import { Link } from 'react-router-dom'
import { IconTools } from '@tabler/icons-react'

// Placeholder for owner routes not yet built — keeps the shell navigable with no
// dead ends (SPEC §3.4). Each says plainly what it will be and where to go now.
export default function ComingSoon({ title, phase }) {
  return (
    <div className="mx-auto max-w-md rounded-lg border border-line bg-card p-10 text-center">
      <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-full bg-saffron/15 text-saffron">
        <IconTools size={26} />
      </div>
      <h2 className="font-[var(--font-display)] text-2xl font-bold">{title}</h2>
      <p className="mt-2 text-muted">
        This screen arrives in {phase || 'a later phase'}. Stock and inventory are
        ready now.
      </p>
      <div className="mt-6 flex justify-center gap-3">
        <Link
          to="/owner/purchase"
          className="rounded-lg bg-peacock px-4 py-2.5 text-sm font-semibold text-white hover:bg-peacock-700"
        >
          New Purchase
        </Link>
        <Link
          to="/owner/inventory"
          className="rounded-lg border border-line bg-card px-4 py-2.5 text-sm font-semibold hover:bg-paper-2"
        >
          View Inventory
        </Link>
      </div>
    </div>
  )
}
