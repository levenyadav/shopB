import { useEffect, useState } from 'react'
import {
  IconBuildingStore, IconCategory, IconUsers, IconPlus, IconCheck,
  IconPencil, IconDeviceFloppy, IconInfoCircle, IconUserPlus,
  IconPalette, IconPhoto, IconUpload, IconX,
} from '@tabler/icons-react'
import { supabase } from '../../lib/supabase'
import { useShop } from '../../context/ShopContext'
import { round2 } from '../../lib/helpers'
import { Button, Field, Select, Textarea, Badge, Spinner } from '../../components/ui'

// SPEC §6.11 — Settings (owner only): shop info, categories, staff. Kept to the
// three named blocks; each writes the table the owner already controls under RLS
// (shops_update, categories_owner_all, profiles_owner_update).
export default function Settings() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <ShopInfo />
      <Branding />
      <Categories />
      <Staff />
    </div>
  )
}

const CAT_TYPES = [
  { value: 'finished_good', label: 'Finished good' },
  { value: 'raw_material', label: 'Raw material' },
  { value: 'resale', label: 'Resale' },
]
const CAT_TYPE_LABEL = Object.fromEntries(CAT_TYPES.map((t) => [t.value, t.label]))

function Card({ icon: Icon, title, hint, children }) {
  return (
    <section className="rounded-lg border border-line bg-card p-5">
      <div className="mb-4 flex items-center gap-3">
        <div className="grid h-9 w-9 place-items-center rounded-lg bg-peacock/10 text-peacock">
          <Icon size={18} />
        </div>
        <div>
          <h3 className="font-semibold text-ink">{title}</h3>
          {hint && <p className="text-xs text-muted">{hint}</p>}
        </div>
      </div>
      {children}
    </section>
  )
}

function Note({ children }) {
  return <p className="rounded-lg bg-saffron/10 px-3 py-2 text-xs text-saffron">{children}</p>
}
function Ok({ children }) {
  return <p className="rounded-lg bg-profit/10 px-3 py-2 text-xs text-profit">{children}</p>
}
function ErrLine({ children }) {
  return <p className="rounded-lg bg-dues/10 px-3 py-2 text-xs text-dues">{children}</p>
}

// ---------------------------------------------------------------------------
// Shop info — name, address, phone, currency symbol.
// ---------------------------------------------------------------------------
function ShopInfo() {
  const { shop, refreshShop } = useShop()
  const [form, setForm] = useState(null)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => {
    if (shop) setForm({
      name: shop.name || '', address: shop.address || '',
      phone: shop.phone || '', currency_symbol: shop.currency_symbol || '₹',
      gstin: shop.gstin || '', gst_rate: shop.gst_rate ? String(shop.gst_rate) : '',
      legal_name: shop.legal_name || '', email: shop.email || '', pan: shop.pan || '',
      state_name: shop.state_name || '', state_code: shop.state_code || '',
      bank_details: shop.bank_details || '', invoice_prefix: shop.invoice_prefix || 'INV',
    })
  }, [shop])

  async function save(e) {
    e.preventDefault()
    setSaving(true); setMsg(''); setErr('')
    const { error } = await supabase.from('shops').update({
      name: form.name.trim(),
      address: form.address.trim() || null,
      phone: form.phone.trim() || null,
      currency_symbol: form.currency_symbol.trim() || '₹',
      gstin: form.gstin.trim() || null,
      gst_rate: round2(form.gst_rate || 0),
      legal_name: form.legal_name.trim() || null,
      email: form.email.trim() || null,
      pan: form.pan.trim() || null,
      state_name: form.state_name.trim() || null,
      state_code: form.state_code.trim() || null,
      bank_details: form.bank_details.trim() || null,
      invoice_prefix: form.invoice_prefix.trim() || 'INV',
    }).eq('id', shop.id)
    setSaving(false)
    if (error) setErr(error.message)
    else { setMsg('Shop details saved.'); await refreshShop() }
  }

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  return (
    <Card icon={IconBuildingStore} title="Shop info" hint="Shows on slips, the shopfront and your dashboard.">
      {!form ? (
        <div className="grid place-items-center py-8 text-muted"><Spinner /></div>
      ) : (
        <form onSubmit={save} className="space-y-4">
          <Field label="Shop name" value={form.name} onChange={set('name')} required />
          <Textarea label="Address" rows={3} value={form.address} onChange={set('address')}
                    placeholder="Street, area, city, state — PIN. Prints on slips & invoices." />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Phone" value={form.phone} onChange={set('phone')} inputMode="tel" />
            <Field label="Currency symbol" value={form.currency_symbol} onChange={set('currency_symbol')} maxLength={3} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="GSTIN" value={form.gstin} onChange={set('gstin')}
                   placeholder="e.g. 27ABCDE1234F1Z5"
                   hint="Leave blank if you don't bill with GST." />
            <Field label="GST rate" suffix="%" type="number" min="0" max="100" step="0.01" inputMode="decimal"
                   value={form.gst_rate} onChange={set('gst_rate')}
                   hint="Shown on invoices when GSTIN is set. Rates are tax-inclusive." />
          </div>

          {/* Invoice billing identity — prints on the customer Tax Invoice. */}
          <div className="space-y-4 rounded-lg border border-line bg-paper-2/40 p-4">
            <p className="text-xs font-medium text-ink">Invoice billing details</p>
            <Field label="Legal / billing name" value={form.legal_name} onChange={set('legal_name')}
                   placeholder={form.name}
                   hint="Registered name printed as the seller on invoices. Defaults to the shop name." />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="PAN" value={form.pan} onChange={set('pan')} placeholder="e.g. AAPFK9899Q" />
              <Field label="Billing e-mail" type="email" value={form.email} onChange={set('email')} />
              <Field label="State name" value={form.state_name} onChange={set('state_name')} placeholder="e.g. Uttar Pradesh" />
              <Field label="State code" value={form.state_code} onChange={set('state_code')} placeholder="e.g. 09" maxLength={2} />
            </div>
            <Textarea label="Bank / UPI details" rows={2} value={form.bank_details} onChange={set('bank_details')}
                      placeholder="Bank name, A/C no, IFSC or UPI ID — printed in the invoice footer." />
            <Field label="Invoice number prefix" value={form.invoice_prefix} onChange={set('invoice_prefix')}
                   placeholder="INV"
                   hint="Invoices are numbered automatically, e.g. INV-0001. Changing the prefix only affects new invoices." />
          </div>

          {msg && <Ok>{msg}</Ok>}
          {err && <ErrLine>{err}</ErrLine>}
          <Button type="submit" disabled={saving}>
            {saving ? <Spinner /> : <IconDeviceFloppy size={18} />} Save shop details
          </Button>
        </form>
      )}
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Branding — logo image, square app icon, and a text wordmark. Logo/icon are
// uploaded to the public 'brand-assets' bucket (or pasted as a URL); brand_text
// is plain text. Shown in the sidebar, the shopfront header and the browser tab.
// ---------------------------------------------------------------------------

// One image slot: pick a file (-> Storage on save) OR paste a URL. A picked file
// wins over the URL. `value` is the saved/pasted URL; `preview` is what to show.
function ImagePicker({ label, hint, square, file, url, onFile, onUrl, onClear }) {
  const [fileUrl, setFileUrl] = useState('')
  useEffect(() => {
    if (!file) { setFileUrl(''); return }
    const u = URL.createObjectURL(file)
    setFileUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [file])
  const preview = file ? fileUrl : url
  const box = square ? 'h-20 w-20' : 'h-20 w-36'
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-ink">{label}</p>
      {hint && <p className="text-xs text-muted">{hint}</p>}
      <div className="flex flex-wrap items-start gap-4">
        <div className={`${box} shrink-0 overflow-hidden rounded-lg border border-line bg-paper-2`}>
          {preview ? (
            <img src={preview} alt={`${label} preview`} className="h-full w-full object-contain" />
          ) : (
            <div className="grid h-full w-full place-items-center text-muted"><IconPhoto size={22} /></div>
          )}
        </div>
        <div className="min-w-[12rem] flex-1 space-y-2">
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-line bg-card px-4 py-2.5 text-sm font-semibold hover:bg-paper-2">
            <IconUpload size={18} /> {preview ? 'Change image' : 'Upload image'}
            <input type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" className="hidden"
                   onChange={(e) => onFile(e.target.files?.[0] || null)} />
          </label>
          <Field label="Or paste image URL" placeholder="https://…"
                 value={file ? '' : url} onChange={(e) => onUrl(e.target.value)} disabled={!!file} />
          {preview && (
            <button type="button" onClick={onClear}
                    className="inline-flex items-center gap-1 text-xs text-dues hover:underline">
              <IconX size={14} /> Remove
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function Branding() {
  const { shop, shopId, refreshShop } = useShop()
  const [logoFile, setLogoFile] = useState(null)
  const [logoUrl, setLogoUrl] = useState('')
  const [iconFile, setIconFile] = useState(null)
  const [iconUrl, setIconUrl] = useState('')
  const [brandText, setBrandText] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => {
    if (!shop) return
    setLogoUrl(shop.logo_url || ''); setIconUrl(shop.icon_url || '')
    setBrandText(shop.brand_text || ''); setLogoFile(null); setIconFile(null)
  }, [shop])

  async function upload(file) {
    const ext = (file.name.split('.').pop() || 'png').toLowerCase()
    const path = `${shopId}/${crypto.randomUUID()}.${ext}`
    const { error } = await supabase.storage
      .from('brand-assets')
      .upload(path, file, { upsert: false, contentType: file.type })
    if (error) throw new Error('Upload failed: ' + error.message)
    return supabase.storage.from('brand-assets').getPublicUrl(path).data.publicUrl
  }

  async function save(e) {
    e.preventDefault()
    setSaving(true); setMsg(''); setErr('')
    try {
      const logo_url = logoFile ? await upload(logoFile) : (logoUrl.trim() || null)
      const icon_url = iconFile ? await upload(iconFile) : (iconUrl.trim() || null)
      const { error } = await supabase.from('shops').update({
        logo_url, icon_url, brand_text: brandText.trim() || null,
      }).eq('id', shop.id)
      if (error) throw error
      setMsg('Branding saved.')
      await refreshShop()
    } catch (e2) {
      setErr(e2.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card icon={IconPalette} title="Branding" hint="Logo and name shown in the menu, the shopfront and the browser tab.">
      {!shop ? (
        <div className="grid place-items-center py-8 text-muted"><Spinner /></div>
      ) : (
        <form onSubmit={save} className="space-y-5">
          <ImagePicker
            label="Logo"
            hint="Wide image shown in the header. PNG with a transparent background works best. Replaces the text name when set."
            file={logoFile} url={logoUrl}
            onFile={(f) => { setLogoFile(f); if (f) setLogoUrl('') }}
            onUrl={setLogoUrl}
            onClear={() => { setLogoFile(null); setLogoUrl('') }}
          />
          <ImagePicker
            label="App icon"
            hint="Small square image used as the browser tab icon (favicon). A simple square mark reads best."
            square
            file={iconFile} url={iconUrl}
            onFile={(f) => { setIconFile(f); if (f) setIconUrl('') }}
            onUrl={setIconUrl}
            onClear={() => { setIconFile(null); setIconUrl('') }}
          />
          <Field label="Text logo" value={brandText} onChange={(e) => setBrandText(e.target.value)}
                 placeholder={shop.name}
                 hint="Shown as the wordmark when no logo image is set. Leave blank to use the shop name." />
          {msg && <Ok>{msg}</Ok>}
          {err && <ErrLine>{err}</ErrLine>}
          <Button type="submit" disabled={saving}>
            {saving ? <Spinner /> : <IconDeviceFloppy size={18} />} Save branding
          </Button>
        </form>
      )}
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Categories — list all, add, rename, activate/deactivate.
// ---------------------------------------------------------------------------
function Categories() {
  const { shopId, refreshCategories } = useShop()
  const [cats, setCats] = useState(null)
  const [err, setErr] = useState('')
  const [name, setName] = useState('')
  const [type, setType] = useState('finished_good')
  const [adding, setAdding] = useState(false)
  const [editId, setEditId] = useState(null)
  const [editName, setEditName] = useState('')

  async function load() {
    // Owner sees all (active + inactive) via categories_owner_all.
    const { data, error } = await supabase
      .from('categories')
      .select('id, name, type, is_active')
      .order('name')
    if (error) setErr(error.message)
    else setCats(data ?? [])
  }
  useEffect(() => { load() }, [])

  async function add(e) {
    e.preventDefault()
    if (!name.trim()) return
    setAdding(true); setErr('')
    const { error } = await supabase.from('categories')
      .insert({ shop_id: shopId, name: name.trim(), type })
    setAdding(false)
    if (error) { setErr(error.message); return }
    setName('')
    await load(); refreshCategories()
  }

  async function rename(id) {
    if (!editName.trim()) { setEditId(null); return }
    setErr('')
    const { error } = await supabase.from('categories')
      .update({ name: editName.trim() }).eq('id', id)
    if (error) { setErr(error.message); return }
    setEditId(null)
    await load(); refreshCategories()
  }

  async function toggle(c) {
    setErr('')
    const { error } = await supabase.from('categories')
      .update({ is_active: !c.is_active }).eq('id', c.id)
    if (error) { setErr(error.message); return }
    await load(); refreshCategories()
  }

  return (
    <Card icon={IconCategory} title="Categories" hint="Used to group items across the shop.">
      <form onSubmit={add} className="mb-4 flex flex-wrap items-end gap-2">
        <div className="min-w-[10rem] flex-1">
          <Field label="New category" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Greeting Cards" />
        </div>
        <div className="w-40">
          <Select label="Type" value={type} onChange={(e) => setType(e.target.value)}>
            {CAT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </Select>
        </div>
        <Button type="submit" disabled={adding}>
          {adding ? <Spinner /> : <IconPlus size={18} />} Add
        </Button>
      </form>

      {err && <ErrLine>{err}</ErrLine>}

      {cats === null ? (
        <div className="grid place-items-center py-8 text-muted"><Spinner /></div>
      ) : cats.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">No categories yet. Add your first above.</p>
      ) : (
        <ul className="divide-y divide-line">
          {cats.map((c) => (
            <li key={c.id} className="flex items-center gap-3 py-2.5">
              {editId === c.id ? (
                <input
                  autoFocus
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') rename(c.id); if (e.key === 'Escape') setEditId(null) }}
                  className="flex-1 rounded-lg border border-peacock bg-card px-2.5 py-1.5 text-sm outline-none focus:ring-1 focus:ring-peacock"
                />
              ) : (
                <span className="min-w-0 flex-1">
                  <span className={`text-sm font-medium ${c.is_active ? 'text-ink' : 'text-muted line-through'}`}>{c.name}</span>
                  <span className="ml-2 text-xs text-muted">{CAT_TYPE_LABEL[c.type] || c.type}</span>
                </span>
              )}

              {!c.is_active && <Badge tone="muted">Hidden</Badge>}

              {editId === c.id ? (
                <button onClick={() => rename(c.id)} className="rounded-lg p-1.5 text-profit hover:bg-paper-2" title="Save name">
                  <IconCheck size={18} />
                </button>
              ) : (
                <button onClick={() => { setEditId(c.id); setEditName(c.name) }} className="rounded-lg p-1.5 text-muted hover:bg-paper-2 hover:text-ink" title="Rename">
                  <IconPencil size={16} />
                </button>
              )}
              <button
                onClick={() => toggle(c)}
                className={`rounded-lg px-2.5 py-1 text-xs font-medium ${c.is_active ? 'text-dues hover:bg-dues/10' : 'text-profit hover:bg-profit/10'}`}
              >
                {c.is_active ? 'Deactivate' : 'Activate'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Staff — add (via the create-staff Edge Function), list, activate/deactivate.
// Creating a login needs the service-role key, so the actual account creation
// happens server-side; the owner just fills the form here.
// ---------------------------------------------------------------------------
const EMPTY_STAFF = { full_name: '', phone: '', email: '', password: '' }

function Staff() {
  const [staff, setStaff] = useState(null)
  const [err, setErr] = useState('')

  // add-form state
  const [form, setForm] = useState(EMPTY_STAFF)
  const [adding, setAdding] = useState(false)
  const [addErr, setAddErr] = useState('')
  const [addMsg, setAddMsg] = useState('')

  async function load() {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, full_name, phone, is_active')
      .eq('role', 'staff')
      .order('full_name')
    if (error) setErr(error.message)
    else setStaff(data ?? [])
  }
  useEffect(() => { load() }, [])

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  async function add(e) {
    e.preventDefault()
    setAdding(true); setAddErr(''); setAddMsg('')
    const { data, error } = await supabase.functions.invoke('create-staff', {
      body: {
        full_name: form.full_name.trim(),
        phone: form.phone.trim(),
        email: form.email.trim(),
        password: form.password,
      },
    })
    setAdding(false)
    // Edge Function returns a non-2xx with { error } on failure; supabase-js
    // surfaces that as `error`, but the body carries the readable message.
    const fnError = error
      ? (await error.context?.json?.().then((b) => b?.error).catch(() => null)) || error.message
      : data?.error
    if (fnError) { setAddErr(fnError); return }
    setAddMsg(`${form.full_name.trim()} can now sign in with ${form.email.trim()}.`)
    setForm(EMPTY_STAFF)
    load()
  }

  async function toggle(p) {
    setErr('')
    const { error } = await supabase.from('profiles')
      .update({ is_active: !p.is_active }).eq('id', p.id)
    if (error) { setErr(error.message); return }
    load()
  }

  return (
    <Card icon={IconUsers} title="Staff" hint="Who can enter purchases and pack orders.">
      <form onSubmit={add} className="mb-5 space-y-3 rounded-lg border border-line bg-paper-2/40 p-4">
        <p className="text-xs font-medium text-ink">Add a staff member</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Full name" value={form.full_name} onChange={set('full_name')} required />
          <Field label="Phone" value={form.phone} onChange={set('phone')} inputMode="tel" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Login email" type="email" value={form.email} onChange={set('email')}
                 autoComplete="off" required />
          <Field label="Temporary password" type="password" value={form.password} onChange={set('password')}
                 autoComplete="new-password" minLength={6} required
                 hint="At least 6 characters. Share it with the staff member to sign in." />
        </div>
        {addMsg && <Ok>{addMsg}</Ok>}
        {addErr && <ErrLine>{addErr}</ErrLine>}
        <Button type="submit" disabled={adding}>
          {adding ? <Spinner /> : <IconUserPlus size={18} />} Add staff
        </Button>
      </form>

      {err && <ErrLine>{err}</ErrLine>}

      {staff === null ? (
        <div className="grid place-items-center py-8 text-muted"><Spinner /></div>
      ) : staff.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">No staff accounts yet. Add your first above.</p>
      ) : (
        <ul className="divide-y divide-line">
          {staff.map((p) => (
            <li key={p.id} className="flex items-center gap-3 py-2.5">
              <span className="min-w-0 flex-1">
                <span className={`text-sm font-medium ${p.is_active ? 'text-ink' : 'text-muted line-through'}`}>{p.full_name}</span>
                {p.phone && <span className="fig ml-2 text-xs text-muted">{p.phone}</span>}
              </span>
              {!p.is_active && <Badge tone="muted">Disabled</Badge>}
              <button
                onClick={() => toggle(p)}
                className={`rounded-lg px-2.5 py-1 text-xs font-medium ${p.is_active ? 'text-dues hover:bg-dues/10' : 'text-profit hover:bg-profit/10'}`}
              >
                {p.is_active ? 'Disable' : 'Enable'}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 flex items-start gap-2">
        <IconInfoCircle size={16} className="mt-0.5 shrink-0 text-muted" />
        <p className="text-xs text-muted">
          Staff sign in with the email and password you set here. Disabling a
          member blocks their access without deleting their history. To reset a
          password, remove and re-add the member, or change it in Supabase Auth.
        </p>
      </div>
    </Card>
  )
}
