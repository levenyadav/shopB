import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  IconSearch, IconPlus, IconPencil, IconPhoto, IconX, IconCircleCheck,
} from '@tabler/icons-react'
import { supabase } from '../../lib/supabase'
import { useShop } from '../../context/ShopContext'
import { money, qty } from '../../lib/format'
import { round2, stockValue } from '../../lib/helpers'
import { Button, Field, Select, StockBadge, Badge, Spinner } from '../../components/ui'

// SPEC §6.2 — Inventory master list. Owner sees all items, searches/filters,
// and edits any field EXCEPT quantity (stock changes only via Purchase Entry,
// Golden Rule #1). Total stock value (owner only) sits at the top.
export default function Inventory() {
  const { categories, suppliers } = useShop()
  const [items, setItems] = useState(null)
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')
  const [cat, setCat] = useState('')
  const [sup, setSup] = useState('')
  const [show, setShow] = useState('active') // active | inactive | all
  const [lowOnly, setLowOnly] = useState(false)
  const [editing, setEditing] = useState(null)

  async function load() {
    setErr('')
    const { data, error } = await supabase
      .from('items')
      .select(
        'id, item_no, name, location, quantity, purchase_rate, dealer_rate, rate, ' +
          'low_stock_threshold, barcode, photo_url, is_active, supplier_id, category_id, ' +
          'supplier:suppliers(name), category:categories(name)',
      )
      .order('item_no')
    if (error) setErr(error.message)
    else setItems(data ?? [])
  }
  useEffect(() => { load() }, [])

  const filtered = useMemo(() => {
    if (!items) return []
    const needle = q.trim().toLowerCase()
    return items.filter((i) => {
      if (show === 'active' && !i.is_active) return false
      if (show === 'inactive' && i.is_active) return false
      if (cat && i.category_id !== cat) return false
      if (sup && i.supplier_id !== sup) return false
      if (lowOnly && !(Number(i.quantity) < Number(i.low_stock_threshold))) return false
      if (needle) {
        const hay = `${i.item_no} ${i.name} ${i.barcode || ''} ${i.supplier?.name || ''} ${i.category?.name || ''}`.toLowerCase()
        if (!hay.includes(needle)) return false
      }
      return true
    })
  }, [items, q, cat, sup, show, lowOnly])

  const totalValue = useMemo(
    () => (items ? items.reduce((s, i) => s + stockValue(i), 0) : 0),
    [items],
  )

  return (
    <div className="space-y-5">
      {/* Top bar: total value + new item */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="rounded-xl border border-line bg-card px-5 py-3">
          <p className="text-xs text-muted">Total stock value (at cost)</p>
          <p className="fig text-2xl font-bold text-profit">{money(totalValue)}</p>
        </div>
        <Link
          to="/owner/purchase"
          className="inline-flex items-center gap-2 rounded-lg bg-peacock px-4 py-2.5 text-sm font-semibold text-white hover:bg-peacock-700"
        >
          <IconPlus size={18} /> New item
        </Link>
      </div>

      {/* Filters */}
      <div className="grid gap-3 rounded-xl border border-line bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="relative sm:col-span-2 lg:col-span-1">
          <IconSearch size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, Item No, barcode…"
            className="w-full rounded-lg border border-line bg-card py-2.5 pl-9 pr-3 text-ink outline-none focus:border-peacock focus:ring-2 focus:ring-peacock/25"
          />
        </div>
        <Select value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="">All categories</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <Select value={sup} onChange={(e) => setSup(e.target.value)}>
          <option value="">All suppliers</option>
          {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
        <div className="flex items-center gap-2">
          <Select value={show} onChange={(e) => setShow(e.target.value)} className="flex-1">
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="all">All</option>
          </Select>
          <button
            type="button"
            onClick={() => setLowOnly((v) => !v)}
            className={`whitespace-nowrap rounded-lg border px-3 py-2.5 text-sm font-medium transition ${
              lowOnly ? 'border-saffron bg-saffron/15 text-saffron' : 'border-line bg-card text-muted hover:text-ink'
            }`}
          >
            Low only
          </button>
        </div>
      </div>

      {/* Table */}
      {err && <p className="rounded-lg bg-dues/10 px-4 py-3 text-sm text-dues">{err}</p>}
      {items === null ? (
        <div className="grid place-items-center py-16 text-muted"><Spinner /></div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-card">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-paper-2 text-muted">
                <tr>
                  <th className="px-4 py-3 font-medium">Item</th>
                  <th className="px-4 py-3 font-medium">Category</th>
                  <th className="px-4 py-3 font-medium text-right">Qty</th>
                  <th className="px-4 py-3 font-medium text-right">Rate</th>
                  <th className="px-4 py-3 font-medium text-right">Value</th>
                  <th className="px-4 py-3 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((i) => (
                  <tr key={i.id} className="border-t border-line hover:bg-paper-2/40">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <Thumb url={i.photo_url} />
                        <div className="min-w-0">
                          <p className="truncate font-medium text-ink">
                            {i.name}
                            {!i.is_active && <Badge className="ml-2" tone="muted">Inactive</Badge>}
                          </p>
                          <p className="fig text-xs text-muted">
                            {i.item_no} · {i.supplier?.name || '—'}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted">{i.category?.name || '—'}</td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <span className="fig">{qty(i.quantity)}</span>
                        <StockBadge quantity={i.quantity} threshold={i.low_stock_threshold} />
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right fig">{money(i.rate)}</td>
                    <td className="px-4 py-3 text-right fig text-muted">{money(stockValue(i))}</td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => setEditing(i)}
                        className="inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-muted hover:text-ink"
                      >
                        <IconPencil size={15} /> Edit
                      </button>
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-12 text-center text-muted">
                      No items match. Adjust the filters, or{' '}
                      <Link to="/owner/purchase" className="font-medium text-peacock hover:underline">
                        add a new item
                      </Link>.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="border-t border-line px-4 py-2.5 text-xs text-muted">
            Showing {filtered.length} of {items.length} item{items.length === 1 ? '' : 's'}
          </div>
        </div>
      )}

      {editing && (
        <EditModal
          item={editing}
          categories={categories}
          suppliers={suppliers}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load() }}
        />
      )}
    </div>
  )
}

function Thumb({ url }) {
  return (
    <div className="h-10 w-10 shrink-0 overflow-hidden rounded-lg border border-line bg-paper-2">
      {url ? (
        <img src={url} alt="" className="h-full w-full object-cover" />
      ) : (
        <div className="grid h-full w-full place-items-center text-muted"><IconPhoto size={18} /></div>
      )}
    </div>
  )
}

function EditModal({ item, categories, suppliers, onClose, onSaved }) {
  const [f, setF] = useState({
    name: item.name,
    supplier_id: item.supplier_id,
    category_id: item.category_id,
    location: item.location || '',
    purchase_rate: String(item.purchase_rate),
    dealer_rate: String(item.dealer_rate),
    rate: String(item.rate),
    low_stock_threshold: String(item.low_stock_threshold),
    barcode: item.barcode || '',
    is_active: item.is_active,
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }))

  async function save(e) {
    e.preventDefault()
    if (!f.name.trim()) { setErr('Item name is required.'); return }
    setBusy(true); setErr('')
    const { error } = await supabase
      .from('items')
      .update({
        name: f.name.trim(),
        supplier_id: f.supplier_id,
        category_id: f.category_id,
        location: f.location.trim() || null,
        purchase_rate: round2(f.purchase_rate),
        dealer_rate: round2(f.dealer_rate),
        rate: round2(f.rate),
        low_stock_threshold: round2(f.low_stock_threshold || 0),
        barcode: f.barcode.trim() || null,
        is_active: f.is_active,
      })
      .eq('id', item.id)
    setBusy(false)
    if (error) { setErr(error.message); return }
    onSaved()
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/40 p-4 overflow-y-auto" onClick={onClose}>
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={save}
        className="my-8 w-full max-w-lg space-y-4 rounded-2xl border border-line bg-card p-6"
      >
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-[var(--font-display)] text-xl font-bold">Edit item</h3>
            <p className="fig text-xs text-muted">{item.item_no}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-muted hover:bg-paper-2">
            <IconX size={20} />
          </button>
        </div>
        {err && <p className="rounded-lg bg-dues/10 px-3 py-2 text-sm text-dues">{err}</p>}

        <Field label="Item name" value={f.name} onChange={set('name')} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Select label="Company / Supplier" value={f.supplier_id} onChange={set('supplier_id')}>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
          <Select label="Category" value={f.category_id} onChange={set('category_id')}>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Location / Rack No" value={f.location} onChange={set('location')} />
          <Field label="Low stock threshold" type="number" min="0" value={f.low_stock_threshold} onChange={set('low_stock_threshold')} />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Purchase Rate" prefix="₹" type="number" min="0" step="0.01" value={f.purchase_rate} onChange={set('purchase_rate')} />
          <Field label="Dealer Rate" prefix="₹" type="number" min="0" step="0.01" value={f.dealer_rate} onChange={set('dealer_rate')} />
          <Field label="Rate (retail)" prefix="₹" type="number" min="0" step="0.01" value={f.rate} onChange={set('rate')} />
        </div>
        <Field label="Barcode / QR" value={f.barcode} onChange={set('barcode')} />

        <div className="flex items-center justify-between rounded-lg bg-paper-2 px-4 py-3">
          <div>
            <p className="text-sm font-medium">Active on shopfront</p>
            <p className="text-xs text-muted">Inactive items stay in records but are hidden from buyers.</p>
          </div>
          <button
            type="button"
            onClick={() => setF((s) => ({ ...s, is_active: !s.is_active }))}
            className={`relative h-6 w-11 rounded-full transition ${f.is_active ? 'bg-peacock' : 'bg-line'}`}
            aria-pressed={f.is_active}
          >
            <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-card transition ${f.is_active ? 'left-[1.375rem]' : 'left-0.5'}`} />
          </button>
        </div>

        <p className="flex items-center gap-1.5 text-xs text-muted">
          <IconCircleCheck size={14} className="text-profit" />
          Stock quantity changes only through Purchase Entry — not editable here.
        </p>

        <div className="flex justify-end gap-3 pt-1">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? <><Spinner /> Saving…</> : 'Save changes'}</Button>
        </div>
      </form>
    </div>
  )
}
