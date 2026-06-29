import { useEffect, useState } from 'react'
import {
  IconBuildingStore, IconCategory, IconUsers, IconPlus, IconCheck,
  IconPencil, IconDeviceFloppy, IconInfoCircle,
} from '@tabler/icons-react'
import { supabase } from '../../lib/supabase'
import { useShop } from '../../context/ShopContext'
import { Button, Field, Select, Badge, Spinner } from '../../components/ui'

// SPEC §6.11 — Settings (owner only): shop info, categories, staff. Kept to the
// three named blocks; each writes the table the owner already controls under RLS
// (shops_update, categories_owner_all, profiles_owner_update).
export default function Settings() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <ShopInfo />
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
    <section className="rounded-2xl border border-line bg-card p-5">
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
          <Field label="Address" value={form.address} onChange={set('address')} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Phone" value={form.phone} onChange={set('phone')} inputMode="tel" />
            <Field label="Currency symbol" value={form.currency_symbol} onChange={set('currency_symbol')} maxLength={3} />
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
                  className="flex-1 rounded-lg border border-peacock bg-card px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-peacock/25"
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
// Staff — list, activate/deactivate. Creating login accounts needs Supabase
// admin (service-role), so that stays a documented note rather than a fake form.
// ---------------------------------------------------------------------------
function Staff() {
  const [staff, setStaff] = useState(null)
  const [err, setErr] = useState('')

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

  async function toggle(p) {
    setErr('')
    const { error } = await supabase.from('profiles')
      .update({ is_active: !p.is_active }).eq('id', p.id)
    if (error) { setErr(error.message); return }
    load()
  }

  return (
    <Card icon={IconUsers} title="Staff" hint="Who can enter purchases and pack orders.">
      {err && <ErrLine>{err}</ErrLine>}

      {staff === null ? (
        <div className="grid place-items-center py-8 text-muted"><Spinner /></div>
      ) : staff.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">No staff accounts yet.</p>
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
          To add a new staff login or reset a password, create the account in
          Supabase Auth and set its profile role to <span className="font-medium">staff</span>.
          A self-serve "Add staff" flow arrives with the admin Edge Function.
        </p>
      </div>
    </Card>
  )
}
