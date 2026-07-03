import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  IconSearch, IconUsers, IconChevronRight, IconUserPlus,
  IconBrandWhatsapp, IconX,
} from '@tabler/icons-react'
import { supabase } from '../../lib/supabase'
import { useShop } from '../../context/ShopContext'
import { useAuth } from '../../context/AuthContext'
import { money } from '../../lib/format'
import { round2, toE164India } from '../../lib/helpers'
import { Badge, Spinner } from '../../components/ui'

// Build a WhatsApp deep link that opens a chat with `phone`, pre-filled with an
// invite to browse the shop. Dealers are told they'll see wholesale rates once
// they sign in with this number. Returns null if the phone isn't valid.
function whatsappInvite({ phone, name, type, shopName }) {
  const e164 = toE164India(phone)
  if (!e164) return null
  const shop = shopName || 'our shop'
  const hello = name ? `Hello ${name},` : 'Hello,'
  const rateLine = type === 'dealer'
    ? ` Sign in with this mobile number (${e164}) to see your dealer (wholesale) rates.`
    : ''
  const text =
    `${hello} welcome to ${shop}! Browse our shop and place your order here: ` +
    `${window.location.origin}/${rateLine}`
  return `https://wa.me/${e164.replace('+', '')}?text=${encodeURIComponent(text)}`
}

// SPEC §6.7 / §6.10 — Parties. One directory for customers, dealers and
// suppliers with running balances. The "Only with balance" toggle turns this
// into the Udhaar list (buyers) and the Supplier dues list at the same time,
// keeping the owner to a single screen (SPEC §3.2).
const TABS = [
  ['all', 'All'], ['customer', 'Customers'], ['dealer', 'Dealers'], ['supplier', 'Suppliers'],
]

export default function Parties() {
  const { currency, shop, suppliers } = useShop()
  const { profile } = useAuth()
  const [buyers, setBuyers] = useState(null)
  const [err, setErr] = useState('')
  const [tab, setTab] = useState('all')
  const [q, setQ] = useState('')
  const [duesOnly, setDuesOnly] = useState(false)
  const [showAdd, setShowAdd] = useState(false)

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

  function onCreated(party) {
    // Prepend the freshly created buyer so it shows immediately (RLS lets the
    // owner read it back). balance_due starts at 0 for a new account.
    setBuyers((list) => [
      { id: party.id, full_name: party.full_name, phone: party.phone,
        role: party.role, balance_due: 0 },
      ...(list ?? []),
    ])
  }

  return (
    <div className="space-y-5">
      {/* Header + create action (SPEC §6.7.2 — owner adds customers/dealers) */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-ink">Parties</h1>
          <p className="text-sm text-muted">Customers, dealers &amp; suppliers</p>
        </div>
        <button
          type="button"
          onClick={() => setShowAdd(true)}
          className="inline-flex items-center gap-2 rounded-lg bg-peacock px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-peacock-700"
        >
          <IconUserPlus size={18} /> New account
        </button>
      </div>

      {showAdd && (
        <AddPartyModal
          shopId={profile?.shop_id}
          shopName={shop?.name}
          onClose={() => setShowAdd(false)}
          onCreated={onCreated}
        />
      )}

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
      <div className="space-y-3 rounded-lg border border-line bg-card p-4">
        <div className="relative">
          <IconSearch size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search name or phone…"
            className="w-full rounded-lg border border-line bg-card py-2.5 pl-9 pr-3 text-ink outline-none focus:border-peacock focus:ring-1 focus:ring-peacock"
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
              className="h-4 w-4 rounded border-line text-peacock focus:ring-peacock"
            />
            Only with balance
          </label>
        </div>
      </div>

      {err && <p className="rounded-lg bg-dues/10 px-4 py-3 text-sm text-dues">{err}</p>}

      {loading ? (
        <div className="grid place-items-center py-16 text-muted"><Spinner /></div>
      ) : filtered.length === 0 ? (
        <div className="grid place-items-center gap-3 rounded-lg border border-dashed border-line py-16 text-center text-muted">
          <IconUsers size={38} stroke={1.3} />
          <p>{duesOnly ? 'Nobody has an outstanding balance here.' : 'No parties to show.'}</p>
        </div>
      ) : (
        <ul className="space-y-2.5">
          {filtered.map((p) => (
            <li key={`${p.type}-${p.id}`}>
              <Link
                to={`/owner/parties/${p.type}/${p.id}`}
                className="flex items-center gap-4 rounded-lg border border-line bg-card p-3.5 transition hover:border-ink/20"
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
                {p.type !== 'supplier' && p.phone && (
                  <button
                    type="button"
                    aria-label={`Share shop link with ${p.name} on WhatsApp`}
                    onClick={(e) => {
                      e.preventDefault(); e.stopPropagation()
                      const url = whatsappInvite({ phone: p.phone, name: p.name, type: p.type, shopName: shop?.name })
                      if (url) window.open(url, '_blank', 'noopener')
                    }}
                    className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-line text-[#25D366] transition hover:border-[#25D366] hover:bg-[#25D366]/10"
                  >
                    <IconBrandWhatsapp size={18} />
                  </button>
                )}
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
    <div className="rounded-lg border border-line bg-card px-5 py-4">
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

// SPEC §6.7.2 — owner adds a customer/dealer. This creates a login-LESS party
// row (no auth user): they authenticate later on their own with phone OTP. The
// row exists so the shop can bill them and track udhaar now, and so the owner
// can share the shop link on WhatsApp. Insert is allowed by the
// profiles_counter_buyer_insert RLS policy (owner/staff, own shop, buyer role).
function AddPartyModal({ shopId, shopName, onClose, onCreated }) {
  const [form, setForm] = useState({ name: '', phone: '', type: 'customer' })
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const [created, setCreated] = useState(null)  // the saved party, once done
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  async function save(e) {
    e.preventDefault()
    setErr('')
    const name = form.name.trim()
    if (!name) { setErr('Enter a name.'); return }
    const phone = toE164India(form.phone)
    if (!phone) { setErr('Enter a valid 10-digit mobile number.'); return }
    if (!shopId) { setErr('No shop context — reload and try again.'); return }
    setSaving(true)
    try {
      const { data, error } = await supabase
        .from('profiles')
        .insert({ shop_id: shopId, full_name: name, phone, role: form.type })
        .select('id, full_name, phone, role')
        .single()
      if (error) throw error
      onCreated(data)
      setCreated(data)
    } catch (e2) {
      setErr(e2.message || 'Could not create the account.')
    } finally {
      setSaving(false)
    }
  }

  function shareWhatsApp() {
    const p = created
    const url = whatsappInvite({ phone: p.phone, name: p.full_name, type: p.role, shopName })
    if (url) window.open(url, '_blank', 'noopener')
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-sm rounded-xl border border-line bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-bold text-ink">
            {created ? 'Account created' : 'New customer / dealer'}
          </h3>
          <button type="button" onClick={onClose} className="text-muted hover:text-ink" aria-label="Close">
            <IconX size={20} />
          </button>
        </div>

        {created ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-line bg-paper-2 p-3">
              <p className="font-medium text-ink">{created.full_name}</p>
              <p className="fig text-sm text-muted">{created.phone} · <span className="capitalize">{created.role}</span></p>
            </div>
            <p className="text-sm text-muted">
              Share the shop link so they can browse and order. They’ll sign in with
              this mobile number to place orders{created.role === 'dealer' ? ' and see dealer rates' : ''}.
            </p>
            <button
              type="button"
              onClick={shareWhatsApp}
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[#25D366] px-4 py-2.5 text-sm font-semibold text-white transition hover:brightness-95"
            >
              <IconBrandWhatsapp size={18} /> Share on WhatsApp
            </button>
            <button
              type="button"
              onClick={() => { setCreated(null); setForm({ name: '', phone: '', type: 'customer' }) }}
              className="w-full rounded-lg border border-line px-4 py-2.5 text-sm font-medium text-ink transition hover:bg-paper-2"
            >
              Add another
            </button>
          </div>
        ) : (
          <form onSubmit={save} className="space-y-4">
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-ink">Name</span>
              <input
                value={form.name} onChange={set('name')} autoFocus
                className="w-full rounded-lg border border-line bg-card px-3 py-2.5 text-ink outline-none focus:border-peacock focus:ring-1 focus:ring-peacock"
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-ink">Mobile number</span>
              <input
                value={form.phone} onChange={set('phone')} type="tel" inputMode="numeric"
                placeholder="98765 43210"
                className="w-full rounded-lg border border-line bg-card px-3 py-2.5 text-ink outline-none focus:border-peacock focus:ring-1 focus:ring-peacock"
              />
            </label>
            <div>
              <span className="mb-1.5 block text-sm font-medium text-ink">Type</span>
              <div className="inline-flex w-full rounded-lg border border-line bg-card p-1">
                {[['customer', 'Customer'], ['dealer', 'Dealer']].map(([key, label]) => (
                  <button
                    key={key} type="button"
                    onClick={() => setForm((f) => ({ ...f, type: key }))}
                    className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition ${
                      form.type === key ? 'bg-peacock text-white' : 'text-muted hover:text-ink'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {err && <p className="rounded-md border border-dues/30 bg-dues/10 px-3 py-2 text-sm text-dues">{err}</p>}

            <button type="submit" disabled={saving} className="w-full rounded-lg bg-peacock px-4 py-2.5 font-semibold text-white transition hover:bg-peacock-700 disabled:opacity-60">
              {saving ? 'Saving…' : 'Create account'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
