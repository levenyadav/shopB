import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { IconArrowLeft, IconPhone, IconCashBanknote, IconDeviceFloppy } from '@tabler/icons-react'
import { supabase } from '../../lib/supabase'
import { useShop } from '../../context/ShopContext'
import { Badge, Spinner, Button, Field, Textarea } from '../../components/ui'
import PartyBalance from '../../components/PartyBalance'
import LedgerTable from '../../components/LedgerTable'

// SPEC §6.7 / §6.10 — Party detail: running balance + full per-party ledger
// (every sale/purchase and payment for this party) + a one-tap Record Payment.
// The ledger render is read-only; balances and entries are trigger-owned
// (Golden Rules #9, #10).
const VALID_TYPES = ['customer', 'dealer', 'supplier']

export default function PartyDetail() {
  const { type, id } = useParams()
  const { currency } = useShop()
  const [party, setParty] = useState(null)
  const [entries, setEntries] = useState(null)
  const [err, setErr] = useState('')
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    let active = true
    async function load() {
      setErr(''); setMissing(false)
      if (!VALID_TYPES.includes(type)) { setMissing(true); return }

      // Party record — suppliers and buyers live in different tables.
      const partyQuery = type === 'supplier'
        ? supabase.from('suppliers')
            .select('id, name, phone, contact_person, address, balance_due').eq('id', id).maybeSingle()
        : supabase.from('profiles')
            .select('id, full_name, phone, role, balance_due, gstin, address, state_name, state_code').eq('id', id).maybeSingle()

      const ledgerQuery = supabase
        .from('ledger')
        .select('id, entry_type, debit, credit, running_balance, description, created_at')
        .eq('party_id', id)
        .eq('party_type', type)
        .order('created_at', { ascending: false })

      const [pRes, lRes] = await Promise.all([partyQuery, ledgerQuery])
      if (!active) return
      if (pRes.error) { setErr(pRes.error.message); return }
      if (!pRes.data) { setMissing(true); return }
      setParty(pRes.data)
      if (lRes.error) setErr(lRes.error.message)
      else setEntries(lRes.data ?? [])
    }
    load()
    return () => { active = false }
  }, [type, id])

  if (missing) return (
    <Empty>Party not found. <Link to="/owner/parties" className="font-medium text-peacock hover:underline">Back to parties</Link>.</Empty>
  )
  if (err && !party) return <Empty>{err}</Empty>
  if (!party) return <div className="grid place-items-center py-20 text-muted"><Spinner /></div>

  const name = type === 'supplier' ? party.name : party.full_name
  const payDirection = type === 'supplier' ? 'out' : 'in'

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <Link to="/owner/parties" className="inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-ink">
        <IconArrowLeft size={17} /> All parties
      </Link>

      {/* Header */}
      <div className="rounded-lg border border-line bg-card p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-xl font-bold">{name || 'Unnamed'}</h2>
            <p className="mt-1 flex items-center gap-3 text-sm text-muted">
              <Badge tone={type === 'dealer' ? 'peacock' : type === 'supplier' ? 'saffron' : 'muted'} className="capitalize">{type}</Badge>
              {party.phone && <span className="fig inline-flex items-center gap-1"><IconPhone size={14} /> {party.phone}</span>}
            </p>
            {type === 'supplier' && party.contact_person && (
              <p className="mt-1 text-sm text-muted">Contact: <span className="text-ink">{party.contact_person}</span></p>
            )}
            {type === 'supplier' && party.address && (
              <p className="mt-0.5 text-sm text-muted">{party.address}</p>
            )}
          </div>
          <Link
            to={`/owner/payments?direction=${payDirection}&id=${party.id}`}
            className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-peacock px-4 py-2.5 text-sm font-semibold text-white hover:bg-peacock-700"
          >
            <IconCashBanknote size={18} /> Record Payment
          </Link>
        </div>
      </div>

      {/* Buyer billing details — feeds the Bill-To block on invoices. Suppliers
          keep their own contact/address fields, so this is buyers only. */}
      {type !== 'supplier' && (
        <BillingEditor party={party} onSaved={(patch) => setParty((p) => ({ ...p, ...patch }))} />
      )}

      <PartyBalance partyType={type} balance={party.balance_due} currency={currency} />

      {/* Ledger */}
      <div className="space-y-2.5">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-muted">Ledger</h3>
        {entries === null ? (
          <div className="grid place-items-center py-12 text-muted"><Spinner /></div>
        ) : (
          <LedgerTable entries={entries} currency={currency} />
        )}
      </div>

      {err && party && <p className="rounded-lg bg-dues/10 px-4 py-3 text-sm text-dues">{err}</p>}
    </div>
  )
}

// Owner-editable GST number + full address for a buyer. Optional; printed as the
// "Bill To" block on customer invoices. Writes via profiles_owner_update RLS.
function BillingEditor({ party, onSaved }) {
  const [form, setForm] = useState({
    gstin: party.gstin || '', address: party.address || '',
    state_name: party.state_name || '', state_code: party.state_code || '',
  })
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const set = (k) => (e) => { setForm((f) => ({ ...f, [k]: e.target.value })); setMsg(''); setErr('') }

  async function save(e) {
    e.preventDefault()
    setSaving(true); setMsg(''); setErr('')
    const patch = {
      gstin: form.gstin.trim() || null, address: form.address.trim() || null,
      state_name: form.state_name.trim() || null, state_code: form.state_code.trim() || null,
    }
    const { error } = await supabase.from('profiles').update(patch).eq('id', party.id)
    setSaving(false)
    if (error) setErr(error.message)
    else { setMsg('Billing details saved.'); onSaved(patch) }
  }

  return (
    <form onSubmit={save} className="space-y-4 rounded-lg border border-line bg-card p-5">
      <div>
        <h3 className="font-semibold text-ink">Billing details</h3>
        <p className="text-xs text-muted">GST number & address for this buyer's invoice. Both optional.</p>
      </div>
      <Field label="GST number" value={form.gstin} onChange={set('gstin')} placeholder="e.g. 27ABCDE1234F1Z5" />
      <Textarea label="Full address" rows={3} value={form.address} onChange={set('address')}
                placeholder="Street, area, city, state — PIN." />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="State name" value={form.state_name} onChange={set('state_name')} placeholder="e.g. Uttar Pradesh" />
        <Field label="State code" value={form.state_code} onChange={set('state_code')} placeholder="e.g. 09" maxLength={2} />
      </div>
      {msg && <p className="rounded-lg bg-profit/10 px-3 py-2 text-xs text-profit">{msg}</p>}
      {err && <p className="rounded-lg bg-dues/10 px-3 py-2 text-xs text-dues">{err}</p>}
      <Button type="submit" disabled={saving}>
        {saving ? <Spinner /> : <IconDeviceFloppy size={18} />} Save billing details
      </Button>
    </form>
  )
}

function Empty({ children }) {
  return <div className="mx-auto max-w-md rounded-lg border border-dashed border-line p-10 text-center text-muted">{children}</div>
}
