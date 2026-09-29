import { useEffect, useState } from 'react'
import { IconWallet, IconDeviceFloppy, IconLogout } from '@tabler/icons-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import { money } from '../../lib/format'
import { Button, Field, Textarea, Spinner } from '../../components/ui'

// SPEC §10.2 — buyer's profile + running balance (udhaar). Balance is maintained
// by triggers (sale on udhaar raises it; Payment In clears it) — read-only here.
// Billing details (GST number + full address) are buyer-editable and feed the
// "Bill To" block on customer invoices (profiles_self_update RLS).
export default function MyAccount() {
  const { profile, role, refreshProfile, signOut } = useAuth()
  const due = Number(profile?.balance_due || 0)

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <div>
        <h1 className="font-[var(--font-display)] text-2xl font-bold text-ink sm:text-3xl">{profile?.full_name || 'My account'}</h1>
        <p className="fig text-sm text-muted">
          {profile?.phone || ''}{role === 'dealer' && <span className="font-sans"> · Dealer account</span>}
        </p>
      </div>

      {/* Udhaar only when there is some — "₹0 owed" is not news. Maintained by
          triggers (sale on udhaar raises it; Payment In clears it); read-only. */}
      {due > 0 && (
        <div className="rounded-xl bg-dues/10 p-5">
          <p className="flex items-center gap-2 text-sm font-medium text-ink/80">
            <IconWallet size={18} aria-hidden /> Udhaar — amount due to the shop
          </p>
          <p className="fig mt-1 text-3xl font-semibold text-dues">{money(due)}</p>
          <p className="mt-1 text-sm text-ink/70">Pay at the counter — the shop records each payment and this updates.</p>
        </div>
      )}

      <BillingDetails profile={profile} refreshProfile={refreshProfile} />

      <button
        type="button" onClick={signOut}
        className="inline-flex h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium text-muted transition-colors duration-150 hover:bg-paper-2 hover:text-ink"
      >
        <IconLogout size={18} aria-hidden /> Sign out
      </button>
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

  const set = (k) => (e) => {
    const v = e.target.value
    setForm((f) => {
      const next = { ...f, [k]: v }
      // A GSTIN starts with the state code (27… = Maharashtra) — fill it in.
      if (k === 'gstin' && /^\d{2}/.test(v.trim()) && !f.state_code) next.state_code = v.trim().slice(0, 2)
      return next
    })
    setMsg(''); setErr('')
  }

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
    <form onSubmit={save} className="space-y-4 rounded-xl bg-card p-5 ring-1 ring-line">
      <div>
        <h2 className="font-semibold text-ink">Billing details</h2>
        <p className="text-sm text-muted">Printed on your invoices. Optional.</p>
      </div>
      <Field label="GST number" value={form.gstin} onChange={set('gstin')}
             placeholder="e.g. 27ABCDE1234F1Z5" />
      <Textarea label="Full address" rows={3} value={form.address} onChange={set('address')}
                placeholder="Street, area, city, state — PIN." />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="State name" value={form.state_name} onChange={set('state_name')} placeholder="e.g. Uttar Pradesh" />
        <Field label="State code" value={form.state_code} onChange={set('state_code')} placeholder="e.g. 09" maxLength={2} />
      </div>
      {msg && <p role="status" className="rounded-lg bg-profit/10 px-3 py-2 text-sm text-profit">{msg}</p>}
      {err && <p role="alert" className="rounded-lg bg-dues/10 px-3 py-2 text-sm text-dues">{err}</p>}
      <Button type="submit" disabled={saving}>
        {saving ? <Spinner /> : <IconDeviceFloppy size={18} />} Save
      </Button>
    </form>
  )
}
