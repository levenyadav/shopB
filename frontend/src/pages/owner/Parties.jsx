import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { IconSearch, IconUsers, IconChevronRight } from '@tabler/icons-react'
import { supabase } from '../../lib/supabase'
import { useShop } from '../../context/ShopContext'
import { money } from '../../lib/format'
import { round2 } from '../../lib/helpers'
import { Badge, Spinner } from '../../components/ui'

// SPEC §6.7 / §6.10 — Parties. One directory for customers, dealers and
// suppliers with running balances. The "Only with balance" toggle turns this
// into the Udhaar list (buyers) and the Supplier dues list at the same time,
// keeping the owner to a single screen (SPEC §3.2).
const TABS = [
  ['all', 'All'], ['customer', 'Customers'], ['dealer', 'Dealers'], ['supplier', 'Suppliers'],
]

export default function Parties() {
  const { currency, suppliers } = useShop()
  const [buyers, setBuyers] = useState(null)
  const [err, setErr] = useState('')
  const [tab, setTab] = useState('all')
  const [q, setQ] = useState('')
  const [duesOnly, setDuesOnly] = useState(false)

  useEffect(() => {
    let active = true
    supabase
      .from('profiles')
      .select('id, full_name, phone, role, balance_due')
      .in('role', ['customer', 'dealer'])
      .order('full_name')
      .then(({ data, error }) => {
        if (!active) return
        if (error) setErr(error.message)
        else setBuyers(data ?? [])
      })
    return () => { active = false }
  }, [])

  // Normalise both tables into one party shape.
  const parties = useMemo(() => {
    const b = (buyers ?? []).map((p) => ({
      id: p.id, type: p.role, name: p.full_name || 'Unnamed',
      phone: p.phone, balance: Number(p.balance_due || 0),
    }))
    const s = (suppliers ?? []).map((p) => ({
      id: p.id, type: 'supplier', name: p.name || 'Unnamed',
      phone: p.phone, balance: Number(p.balance_due || 0),
    }))
    return [...b, ...s]
  }, [buyers, suppliers])

  const totals = useMemo(() => {
    let udhaar = 0, dues = 0
    for (const p of parties) {
      if (p.balance <= 0) continue
      if (p.type === 'supplier') dues = round2(dues + p.balance)
      else udhaar = round2(udhaar + p.balance)
    }
    return { udhaar, dues }
  }, [parties])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return parties
      .filter((p) => (tab === 'all' ? true : p.type === tab))
      .filter((p) => (duesOnly ? p.balance > 0 : true))
      .filter((p) => !needle || `${p.name} ${p.phone || ''}`.toLowerCase().includes(needle))
      .sort((a, b) => b.balance - a.balance || a.name.localeCompare(b.name))
  }, [parties, tab, q, duesOnly])

  const loading = buyers === null

  return (
    <div className="space-y-5">
      {/* Money owed both ways — labelled figures (SPEC §3.3) */}
      <div className="grid gap-3 sm:grid-cols-2">
        <SummaryCard
          label="Udhaar owed to shop" value={totals.udhaar} currency={currency}
          hint="From customers & dealers"
        />
        <SummaryCard
          label="Dues we owe suppliers" value={totals.dues} currency={currency}
          hint="To clear via Payment Out"
        />
      </div>

      {/* Filters */}
      <div className="space-y-3 rounded-xl border border-line bg-card p-4">
        <div className="relative">
          <IconSearch size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search name or phone…"
            className="w-full rounded-lg border border-line bg-card py-2.5 pl-9 pr-3 text-ink outline-none focus:border-peacock focus:ring-2 focus:ring-peacock/25"
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-1.5">
            {TABS.map(([key, label]) => (
              <button
                key={key} type="button" onClick={() => setTab(key)}
                className={`rounded-full border px-3 py-1.5 text-sm font-medium transition ${
                  tab === key ? 'border-peacock bg-peacock text-white' : 'border-line bg-card text-muted hover:text-ink'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-muted">
            <input
              type="checkbox" checked={duesOnly}
              onChange={(e) => setDuesOnly(e.target.checked)}
              className="h-4 w-4 rounded border-line text-peacock focus:ring-peacock/25"
            />
            Only with balance
          </label>
        </div>
      </div>

      {err && <p className="rounded-lg bg-dues/10 px-4 py-3 text-sm text-dues">{err}</p>}

      {loading ? (
        <div className="grid place-items-center py-16 text-muted"><Spinner /></div>
      ) : filtered.length === 0 ? (
        <div className="grid place-items-center gap-3 rounded-2xl border border-dashed border-line py-16 text-center text-muted">
          <IconUsers size={38} stroke={1.3} />
          <p>{duesOnly ? 'Nobody has an outstanding balance here.' : 'No parties to show.'}</p>
        </div>
      ) : (
        <ul className="space-y-2.5">
          {filtered.map((p) => (
            <li key={`${p.type}-${p.id}`}>
              <Link
                to={`/owner/parties/${p.type}/${p.id}`}
                className="flex items-center gap-4 rounded-xl border border-line bg-card p-3.5 transition hover:shadow-sm"
              >
                <Avatar name={p.name} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-ink">
                    {p.name}
                    <TypeBadge type={p.type} />
                  </p>
                  <p className="fig truncate text-xs text-muted">{p.phone || 'No phone'}</p>
                </div>
                <div className="text-right">
                  {p.balance > 0 ? (
                    <>
                      <p className="fig font-semibold text-dues">{money(p.balance).replace('₹', currency)}</p>
                      <p className="text-xs text-muted">{p.type === 'supplier' ? 'we owe' : 'udhaar'}</p>
                    </>
                  ) : (
                    <p className="text-xs text-profit">Settled</p>
                  )}
                </div>
                <IconChevronRight size={18} className="text-muted" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function SummaryCard({ label, value, hint, currency }) {
  return (
    <div className="rounded-xl border border-line bg-card px-5 py-4">
      <p className="text-xs text-muted">{label}</p>
      <p className={`fig mt-0.5 text-2xl font-bold ${value > 0 ? 'text-dues' : 'text-profit'}`}>
        {money(value).replace('₹', currency)}
      </p>
      <p className="mt-0.5 text-xs text-muted">{hint}</p>
    </div>
  )
}

function TypeBadge({ type }) {
  const tone = type === 'dealer' ? 'peacock' : type === 'supplier' ? 'saffron' : 'muted'
  return <Badge tone={tone} className="ml-1.5 capitalize">{type}</Badge>
}

function Avatar({ name }) {
  const initial = (name || '?').trim().charAt(0).toUpperCase()
  return (
    <div className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-paper-2 text-sm font-bold text-muted">
      {initial}
    </div>
  )
}
