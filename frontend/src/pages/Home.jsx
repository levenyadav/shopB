import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { money, qty } from '../lib/format'

// Phase 1 placeholder home. Confirms auth, profile load, and RLS-scoped reads
// work end to end. Real role dashboards arrive in later phases (SPEC §10).
export default function Home() {
  const { profile, role, signOut } = useAuth()
  const [items, setItems] = useState([])
  const [err, setErr] = useState('')

  useEffect(() => {
    supabase
      .from('items')
      .select('item_no, name, quantity, rate')
      .order('item_no')
      .then(({ data, error }) => {
        if (error) setErr(error.message)
        else setItems(data ?? [])
      })
  }, [])

  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between border-b border-line bg-card px-6 py-4">
        <span className="shop-stamp text-xs font-bold">Shree Card &amp; Gift</span>
        <button
          onClick={signOut}
          className="text-sm font-medium text-muted hover:text-ink"
        >
          Sign out
        </button>
      </header>

      <main className="mx-auto max-w-3xl p-6 sm:p-10">
        <p className="text-muted">Signed in as</p>
        <h1 className="font-[var(--font-display)] text-3xl font-bold">
          {profile?.full_name || 'New user'}
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          <span className="rounded-full bg-peacock/10 text-peacock px-3 py-1 capitalize">
            {role || 'no role yet'}
          </span>
          <span className="text-muted">
            Balance due:{' '}
            <span className="fig text-dues">{money(profile?.balance_due)}</span>
          </span>
        </div>

        <section className="mt-8">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted mb-3">
            Stock visible to you
            <span className="ml-2 normal-case font-normal">(scoped by RLS)</span>
          </h2>
          {err && <p className="text-dues text-sm">{err}</p>}
          <div className="overflow-hidden rounded-xl border border-line bg-card">
            <table className="w-full text-left text-sm">
              <thead className="bg-paper-2 text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">Item</th>
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium text-right">Qty</th>
                  <th className="px-4 py-2 font-medium text-right">Rate</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => (
                  <tr key={it.item_no} className="border-t border-line">
                    <td className="px-4 py-2 fig text-muted">{it.item_no}</td>
                    <td className="px-4 py-2">{it.name}</td>
                    <td className="px-4 py-2 text-right fig">{qty(it.quantity)}</td>
                    <td className="px-4 py-2 text-right fig">{money(it.rate)}</td>
                  </tr>
                ))}
                {items.length === 0 && !err && (
                  <tr>
                    <td colSpan={4} className="px-4 py-6 text-center text-muted">
                      No items visible to your role.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-muted">
            Foundation check. Role dashboards, purchases, orders and ledger come next.
          </p>
        </section>
      </main>
    </div>
  )
}
