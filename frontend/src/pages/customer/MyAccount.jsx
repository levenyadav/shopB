import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { IconReceipt2, IconWallet, IconDeviceFloppy } from '@tabler/icons-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import { useShop } from '../../context/ShopContext'
import { money } from '../../lib/format'
import { Button, Field, Textarea, Spinner } from '../../components/ui'

// SPEC §10.2 — buyer's profile + running balance (udhaar). Balance is maintained
// by triggers (sale on udhaar raises it; Payment In clears it) — read-only here.
// Billing details (GST number + full address) are buyer-editable and feed the
// "Bill To" block on customer invoices (profiles_self_update RLS).
export default function MyAccount() {
  const { profile, role, refreshProfile } = useAuth()
  const { currency } = useShop()
  const due = Number(profile?.balance_due || 0)

  return (
    <div className="mx-auto max-w-xl space-y-5">
      <div>
        <h1 className="font-[var(--font-display)] text-3xl font-bold">My account</h1>
        <p className="text-muted">Your details and running balance with the shop.</p>
      </div>

      <div className="rounded-lg border border-line bg-card p-5">
        <dl className="grid grid-cols-2 gap-4 text-sm">
          <Row label="Name" value={profile?.full_name || '—'} />
          <Row label="Phone" value={profile?.phone || '—'} />
          <Row label="Account type" value={<span className="capitalize">{role}</span>} />
        </dl>
      </div>

      <BillingDetails profile={profile} refreshProfile={refreshProfile} />

      <div className={`rounded-lg border p-5 ${due > 0 ? 'border-dues/30 bg-dues/10' : 'border-profit/30 bg-profit/10'}`}>
        <div className="flex items-center gap-2 text-muted">
          <IconWallet size={18} />
          <p className="text-sm font-medium">Udhaar (running balance)</p>
        </div>
        <p className={`fig mt-1 text-3xl font-bold ${due > 0 ? 'text-dues' : 'text-profit'}`}>
          {money(due).replace('₹', currency)}
        </p>
        <p className="mt-1 text-sm text-ink/70">
          {due > 0
            ? 'This is what you owe the shop. Clear it at the counter — the shop records each payment.'
            : 'You have no outstanding balance. All clear.'}
        </p>
      </div>

      <Link
        to="/orders"
        className="inline-flex items-center gap-2 rounded-lg border border-line bg-card px-4 py-2.5 text-sm font-semibold hover:bg-paper-2"
      >
        <IconReceipt2 size={18} /> View my orders
      </Link>
    </div>
  )
}

// Buyer billing details — GST number + full address for invoices. Optional.
function BillingDetails({ profile, refreshProfile }) {
  const [form, setForm] = useState({ gstin: '', address: '', state_name: '', state_code: '' })
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => {
    if (profile) setForm({
      gstin: profile.gstin || '', address: profile.address || '',
      state_name: profile.state_name || '', state_code: profile.state_code || '',
    })
  }, [profile?.id, profile?.gstin, profile?.address, profile?.state_name, profile?.state_code])

  const set = (k) => (e) => { setForm((f) => ({ ...f, [k]: e.target.value })); setMsg(''); setErr('') }

  async function save(e) {
    e.preventDefault()
    setSaving(true); setMsg(''); setErr('')
    const { error } = await supabase.from('profiles').update({
      gstin: form.gstin.trim() || null,
      address: form.address.trim() || null,
      state_name: form.state_name.trim() || null,
      state_code: form.state_code.trim() || null,
    }).eq('id', profile.id)
    setSaving(false)
    if (error) setErr(error.message)
    else { setMsg('Billing details saved.'); await refreshProfile() }
  }

  return (
    <form onSubmit={save} className="space-y-4 rounded-lg border border-line bg-card p-5">
      <div>
        <h2 className="font-semibold text-ink">Billing details</h2>
        <p className="text-xs text-muted">Used on the invoice the shop gives you. Both optional.</p>
      </div>
      <Field label="GST number" value={form.gstin} onChange={set('gstin')}
             placeholder="e.g. 27ABCDE1234F1Z5" />
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

function Row({ label, value }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-ink">{value}</dd>
    </div>
  )
}
