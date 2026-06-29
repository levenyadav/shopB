import { useEffect, useMemo, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { IconSearch, IconMoodEmpty } from '@tabler/icons-react'
import { supabase } from '../../lib/supabase'
import { useShop } from '../../context/ShopContext'
import { Spinner } from '../../components/ui'
import ItemCard from '../../components/ItemCard'

// SPEC §6.3 — the customer-facing shopfront, auto-generated from live inventory.
// Browse by category, search by name. Only active, in-stock items appear — we
// filter client-side too so an owner previewing the page sees what buyers see
// (their RLS would otherwise return out-of-stock / inactive rows).
export default function Shopfront() {
  const { categoryId } = useParams()
  const navigate = useNavigate()
  const { categories } = useShop()
  const [items, setItems] = useState(null)
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')

  // shopfront_items is the column-safe view (no purchase_rate — Golden Rule #4).
  // Category names come from ShopContext, so no embed through the view is needed.
  const catName = useMemo(
    () => Object.fromEntries(categories.map((c) => [c.id, c.name])),
    [categories],
  )

  useEffect(() => {
    let active = true
    supabase
      .from('shopfront_items')
      .select('id, name, quantity, rate, dealer_rate, low_stock_threshold, photo_url, category_id')
      .order('name')
      .then(({ data, error }) => {
        if (!active) return
        if (error) setErr(error.message)
        else setItems(data ?? [])
      })
    return () => { active = false }
  }, [])

  const visible = useMemo(() => {
    if (!items) return []
    const needle = q.trim().toLowerCase()
    return items.filter((i) => {
      if (categoryId && i.category_id !== categoryId) return false
      if (needle && !i.name.toLowerCase().includes(needle)) return false
      return true
    })
  }, [items, categoryId, q])

  const setCategory = (id) => navigate(id ? `/shop/${id}` : '/')

  return (
    <div className="space-y-6">
      {/* Heading + search */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-[var(--font-display)] text-3xl font-bold">Our shop</h1>
          <p className="text-muted">Browse below and place an order. We confirm every order before packing.</p>
        </div>
        <div className="relative w-full sm:w-72">
          <IconSearch size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search items…"
            className="w-full rounded-lg border border-line bg-card py-2.5 pl-9 pr-3 text-ink outline-none focus:border-peacock focus:ring-2 focus:ring-peacock/25"
          />
        </div>
      </div>

      {/* Category tabs */}
      <div className="-mx-1 flex gap-2 overflow-x-auto pb-1">
        <Tab active={!categoryId} onClick={() => setCategory('')}>All</Tab>
        {categories.map((c) => (
          <Tab key={c.id} active={categoryId === c.id} onClick={() => setCategory(c.id)}>
            {c.name}
          </Tab>
        ))}
      </div>

      {err && <p className="rounded-lg bg-dues/10 px-4 py-3 text-sm text-dues">{err}</p>}

      {items === null ? (
        <div className="grid place-items-center py-20 text-muted"><Spinner /></div>
      ) : visible.length === 0 ? (
        <div className="grid place-items-center gap-3 rounded-2xl border border-dashed border-line py-20 text-center text-muted">
          <IconMoodEmpty size={40} stroke={1.3} />
          <p>
            {q || categoryId
              ? 'No items match here. Try another category or search.'
              : 'No items are in stock right now. Please check back soon.'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {visible.map((item) => (
            <ItemCard key={item.id} item={item} categoryName={catName[item.category_id]} />
          ))}
        </div>
      )}
    </div>
  )
}

function Tab({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 rounded-full border px-4 py-1.5 text-sm font-medium transition ${
        active
          ? 'border-peacock bg-peacock text-white'
          : 'border-line bg-card text-muted hover:text-ink'
      }`}
    >
      {children}
    </button>
  )
}
