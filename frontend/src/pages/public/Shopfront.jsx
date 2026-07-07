import { useEffect, useMemo, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { IconSearch, IconMoodEmpty, IconChevronLeft, IconChevronRight } from '@tabler/icons-react'
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
  const { categories, shop } = useShop()
  const [items, setItems] = useState(null)
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')
  const [activeTag, setActiveTag] = useState('')

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
      .select('id, name, quantity, rate, dealer_rate, low_stock_threshold, photo_url, category_id, tags, description, moq, made_to_order')
      .order('name')
      .then(({ data, error }) => {
        if (!active) return
        if (error) setErr(error.message)
        else setItems(data ?? [])
      })
    return () => { active = false }
  }, [])

  // Distinct tags across the in-stock catalogue, for the filter chips.
  const allTags = useMemo(() => {
    if (!items) return []
    const set = new Set()
    items.forEach((i) => (i.tags || []).forEach((t) => set.add(t)))
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [items])

  const visible = useMemo(() => {
    if (!items) return []
    const needle = q.trim().toLowerCase()
    return items.filter((i) => {
      if (categoryId && i.category_id !== categoryId) return false
      if (activeTag && !(i.tags || []).includes(activeTag)) return false
      if (needle) {
        const hay = `${i.name} ${(i.tags || []).join(' ')} ${i.description || ''}`.toLowerCase()
        if (!hay.includes(needle)) return false
      }
      return true
    })
  }, [items, categoryId, q, activeTag])

  const setCategory = (id) => navigate(id ? `/shop/${id}` : '/')

  const onlyOneCategory = !categoryId
  const activeCatName = categoryId ? catName[categoryId] : null

  return (
    <div className="space-y-6">
      {/* Banner carousel — only on the all-items home view, hidden when empty */}
      {onlyOneCategory && <BannerCarousel banners={shop?.banners} navigate={navigate} />}

      {/* Hero heading + search */}
      <div className="flex flex-col gap-4 rounded-2xl border border-line bg-gradient-to-br from-peacock/[0.07] via-card to-saffron/[0.07] px-5 py-6 sm:flex-row sm:items-end sm:justify-between sm:px-7 sm:py-8">
        <div className="space-y-1.5">
          <h1 className="font-[var(--font-display)] text-3xl font-bold text-ink sm:text-4xl">
            {activeCatName || `Welcome to ${shop?.name || 'our shop'}`}
          </h1>
          <p className="max-w-md text-muted">
            {activeCatName
              ? `Browse our ${activeCatName.toLowerCase()}. Place an order and we'll confirm before packing.`
              : 'Browse our collection and place an order. We confirm every order before packing.'}
          </p>
        </div>
        <div className="relative w-full sm:w-72">
          <IconSearch size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search items…"
            className="w-full rounded-lg border border-line bg-card py-2.5 pl-9 pr-3 text-ink outline-none focus:border-peacock focus:ring-1 focus:ring-peacock"
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

      {/* Tag filter chips */}
      {allTags.length > 0 && (
        <div className="-mx-1 flex flex-wrap gap-2">
          <Chip active={!activeTag} onClick={() => setActiveTag('')}>All tags</Chip>
          {allTags.map((t) => (
            <Chip key={t} active={activeTag === t} onClick={() => setActiveTag(activeTag === t ? '' : t)}>
              #{t}
            </Chip>
          ))}
        </div>
      )}

      {err && <p className="rounded-lg bg-dues/10 px-4 py-3 text-sm text-dues">{err}</p>}

      {items === null ? (
        <div className="grid place-items-center py-20 text-muted"><Spinner /></div>
      ) : visible.length === 0 ? (
        <div className="grid place-items-center gap-3 rounded-lg border border-dashed border-line py-20 text-center text-muted">
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

// Auto-sliding banner carousel. Slides come from shops.banners (set in Settings).
// Renders nothing when there are no banners. A slide with a `link` is clickable —
// internal links ("/shop/…") route in-app; anything else opens in a new tab.
function BannerCarousel({ banners, navigate }) {
  const slides = Array.isArray(banners) ? banners.filter((b) => b?.image_url) : []
  const [i, setI] = useState(0)
  const [paused, setPaused] = useState(false)

  // Keep the index valid if the list shrinks.
  useEffect(() => { if (i >= slides.length) setI(0) }, [slides.length, i])

  // Auto-advance every 5s, unless paused (hover) or there's a single slide.
  useEffect(() => {
    if (slides.length < 2 || paused) return
    const t = setInterval(() => setI((n) => (n + 1) % slides.length), 5000)
    return () => clearInterval(t)
  }, [slides.length, paused])

  if (slides.length === 0) return null

  const go = (n) => setI((n + slides.length) % slides.length)
  const open = (link) => {
    if (!link) return
    if (link.startsWith('/')) navigate(link)
    else window.open(link, '_blank', 'noopener,noreferrer')
  }

  return (
    <div
      className="relative overflow-hidden rounded-2xl border border-line bg-paper-2"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="flex transition-transform duration-500 ease-out" style={{ transform: `translateX(-${i * 100}%)` }}>
        {slides.map((b, idx) => (
          <button
            key={idx}
            type="button"
            onClick={() => open(b.link)}
            className={`relative aspect-[3/1] w-full shrink-0 ${b.link ? 'cursor-pointer' : 'cursor-default'}`}
            aria-label={b.caption || `Banner ${idx + 1}`}
          >
            <img src={b.image_url} alt={b.caption || ''} className="h-full w-full object-cover" />
            {b.caption && (
              <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-ink/70 to-transparent px-5 py-4 text-left text-base font-semibold text-white sm:px-7 sm:py-5 sm:text-lg">
                {b.caption}
              </span>
            )}
          </button>
        ))}
      </div>

      {slides.length > 1 && (
        <>
          <button type="button" onClick={() => go(i - 1)} aria-label="Previous banner"
                  className="absolute left-2 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-full bg-card/80 text-ink shadow hover:bg-card sm:left-3">
            <IconChevronLeft size={20} />
          </button>
          <button type="button" onClick={() => go(i + 1)} aria-label="Next banner"
                  className="absolute right-2 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-full bg-card/80 text-ink shadow hover:bg-card sm:right-3">
            <IconChevronRight size={20} />
          </button>
          <div className="absolute inset-x-0 bottom-2.5 flex justify-center gap-1.5">
            {slides.map((_, idx) => (
              <button key={idx} type="button" onClick={() => setI(idx)} aria-label={`Go to banner ${idx + 1}`}
                      className={`h-1.5 rounded-full transition-all ${idx === i ? 'w-5 bg-white' : 'w-1.5 bg-white/60 hover:bg-white/80'}`} />
            ))}
          </div>
        </>
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

function Chip({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 rounded-full border px-3 py-1 text-xs font-medium transition ${
        active
          ? 'border-saffron bg-saffron/15 text-saffron'
          : 'border-line bg-card text-muted hover:text-ink'
      }`}
    >
      {children}
    </button>
  )
}
