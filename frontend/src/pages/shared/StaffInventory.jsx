import { useEffect, useMemo, useState } from 'react'
import { IconSearch, IconCheck, IconX, IconPencil } from '@tabler/icons-react'
import { supabase } from '../../lib/supabase'
import { qty, money } from '../../lib/format'
import { StockBadge, Spinner } from '../../components/ui'

// SPEC §9.1/§10.3 — staff Inventory. Staff SEE stock (photo, name, category,
// quantity, retail rate) from the cost-safe `staff_items` view — never
// purchase_rate or profit. The one thing they may change is the rack LOCATION
// (items_staff_update RLS allows location/quantity); quantity stays read-only
// here so stock only ever moves via Purchase Entry / a sale (Golden Rules).
export default function StaffInventory() {
  const [items, setItems] = useState(null)
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')
  const [editId, setEditId] = useState(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => { load() }, [])

  async function load() {
    const { data, error } = await supabase
      .from('staff_items')
      .select('id, item_no, name, category_name, location, quantity, low_stock_threshold, rate, photo_url')
      .order('name', { ascending: true })
    if (error) setErr(error.message)
    else setItems(data ?? [])
  }

  const rows = useMemo(() => {
    if (!items) return []
    const t = q.trim().toLowerCase()
    if (!t) return items
    return items.filter(
      (i) =>
        i.name?.toLowerCase().includes(t) ||
        String(i.item_no).toLowerCase().includes(t) ||
        i.location?.toLowerCase().includes(t) ||
        i.category_name?.toLowerCase().includes(t),
    )
  }, [items, q])

  function startEdit(i) {
    setEditId(i.id)
    setDraft(i.location || '')
    setErr('')
  }
  function cancelEdit() {
    setEditId(null)
    setDraft('')
  }

  async function saveLocation(id) {
    setSaving(true)
    setErr('')
    const value = draft.trim() || null
    const { error } = await supabase.from('items').update({ location: value }).eq('id', id)
    setSaving(false)
    if (error) { setErr(error.message); return }
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, location: value } : i)))
    cancelEdit()
  }

  return (
    <div className="space-y-5">
      <div className="no-print">
        <h1 className="font-[var(--font-display)] text-2xl font-bold">Inventory</h1>
        <p className="text-sm text-muted">See stock and keep rack locations tidy. Quantities change only through purchases and sales.</p>
      </div>

      <div className="relative">
        <IconSearch size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search name, item no, rack or category…"
          className="w-full rounded-lg border border-line bg-card py-2.5 pl-10 pr-3 text-sm outline-none focus:border-peacock focus:ring-1 focus:ring-peacock"
        />
      </div>

      {err && <p className="rounded-lg bg-dues/10 px-4 py-3 text-sm text-dues">{err}</p>}

      {items === null ? (
        <div className="grid place-items-center py-16 text-muted"><Spinner /></div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-line bg-card">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-paper-2 text-muted">
                <tr>
                  <th className="px-4 py-3 font-medium">Item No</th>
                  <th className="px-4 py-3 font-medium">Name</th>
                  <th className="px-4 py-3 font-medium">Category</th>
                  <th className="px-4 py-3 font-medium">Rack / Location</th>
                  <th className="px-4 py-3 font-medium text-right">Quantity</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium text-right">Rate</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((i) => (
                  <tr key={i.id} className="border-t border-line">
                    <td className="px-4 py-3 fig text-muted">{i.item_no}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {i.photo_url && (
                          <img src={i.photo_url} alt="" className="h-8 w-8 rounded object-cover" />
                        )}
                        <span className="font-medium text-ink">{i.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted">{i.category_name || '—'}</td>
                    <td className="px-4 py-3">
                      {editId === i.id ? (
                        <div className="flex items-center gap-1.5">
                          <input
                            autoFocus
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') saveLocation(i.id)
                              if (e.key === 'Escape') cancelEdit()
                            }}
                            placeholder="e.g. A-3"
                            className="w-24 rounded-md border border-line bg-paper px-2 py-1 text-sm outline-none focus:border-peacock"
                          />
                          <button
                            type="button" disabled={saving} onClick={() => saveLocation(i.id)}
                            className="rounded-md bg-profit/15 p-1.5 text-profit hover:bg-profit/25 disabled:opacity-50"
                            title="Save"
                          >
                            <IconCheck size={15} />
                          </button>
                          <button
                            type="button" onClick={cancelEdit}
                            className="rounded-md bg-paper-2 p-1.5 text-muted hover:text-ink"
                            title="Cancel"
                          >
                            <IconX size={15} />
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => startEdit(i)}
                          className="group inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-paper-2"
                          title="Edit location"
                        >
                          <span className={i.location ? 'fig text-ink' : 'text-muted italic'}>
                            {i.location || 'unset'}
                          </span>
                          <IconPencil size={13} className="text-muted opacity-0 transition group-hover:opacity-100" />
                        </button>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right fig">{qty(i.quantity)}</td>
                    <td className="px-4 py-3">
                      <StockBadge quantity={i.quantity} threshold={i.low_stock_threshold} />
                    </td>
                    <td className="px-4 py-3 text-right fig">{money(i.rate)}</td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center text-muted">
                      {q ? 'No items match your search.' : 'No active items yet.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
