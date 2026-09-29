import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate, useLocation, useNavigationType, useSearchParams } from 'react-router-dom'
import { IconAdjustmentsHorizontal, IconX, IconSearch, IconRefresh } from '@tabler/icons-react'
import { supabase, fetchAll } from '../../lib/supabase'
import { useShop } from '../../context/ShopContext'
import { useAuth } from '../../context/AuthContext'
import { rateForBuyer } from '../../lib/helpers'
import { money } from '../../lib/format'
import { Img } from '../../components/ui'
import ItemCard from '../../components/ItemCard'

// SPEC §6.3 — the customer-facing shopfront, auto-generated from live inventory.
// Browse by category, search (header box), sort, and narrow down with Filters
// (tag / price). Only active, in-stock items appear — we filter client-side too
// so an owner previewing the page sees what buyers see.
//
// Everything a buyer sets lives in the URL (?q=&tag=&min=&max=&sort=), and how
// far they'd scrolled / how many "Show more" pages they'd opened is saved per
// URL — so Back from a product lands them exactly where they were.
const PAGE = 60
const COLUMNS =
  'id, name, quantity, rate, dealer_rate, low_stock_threshold, photo_url, category_id, tags, description, moq, made_to_order, company_no, created_at'
const SORTS = [
  { value: '',           label: 'Featured' },
  { value: 'price-asc',  label: 'Price: low to high' },
  { value: 'price-desc', label: 'Price: high to low' },
  { value: 'new',        label: 'Newest first' },
]

// The catalogue survives unmounts, so returning from a product renders the grid
// at once (no spinner, and the saved scroll position still exists). Refreshed in
// the background when older than a minute.
let catalogue = { rows: null, at: 0 }
const STALE_MS = 60_000

const viewKey = (loc) => `shopfront:${loc.pathname}${loc.search}`
function readView(key) {
  try { return JSON.parse(sessionStorage.getItem(key)) || null } catch { return null }
}

export default function Shopfront() {
  const { categoryId } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const navType = useNavigationType()
  const [params, setParams] = useSearchParams()
  const { categories, shop, currency } = useShop()
  const { role } = useAuth()

  const q = params.get('q') || ''
  const tag = params.get('tag') || ''
  const minP = params.get('min') || ''
  const maxP = params.get('max') || ''
  const sort = params.get('sort') || ''

  const [items, setItems] = useState(catalogue.rows)
  const [err, setErr] = useState('')
  const [reload, setReload] = useState(0)
  const [showFilters, setShowFilters] = useState(false)

  // Returning via Back (POP) → pick up the saved view for this exact URL.
  const saved = useRef(navType === 'POP' ? readView(viewKey(location)) : null)
  const [shown, setShown] = useState(saved.current?.shown || PAGE)

  useEffect(() => {
    if (catalogue.rows && Date.now() - catalogue.at < STALE_MS && !reload) return
    let active = true
    setErr('')
    // shopfront_items is the column-safe view (no purchase_rate — Golden Rule #4).
    fetchAll(() => supabase.from('shopfront_items').select(COLUMNS).order('name').order('id'))
      .then(({ data, error }) => {
        if (!active) return
        if (error) { if (!catalogue.rows) setErr(error.message); return }
        catalogue = { rows: data ?? [], at: Date.now() }
        setItems(catalogue.rows)
      })
    return () => { active = false }
  }, [reload])

  // Save scroll + page count for this URL. A layout-effect cleanup runs before
  // the next page paints, so it records where the buyer really was — not where
  // the shorter product page clamps the scroll to.
  const lastY = useRef(saved.current?.y || 0)
  const keyRef = useRef(viewKey(location))
  const shownRef = useRef(shown)
  keyRef.current = viewKey(location)
  shownRef.current = shown
  useLayoutEffect(() => {
    const onScroll = () => { lastY.current = window.scrollY }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      try {
        sessionStorage.setItem(keyRef.current, JSON.stringify({ y: lastY.current, shown: shownRef.current }))
      } catch { /* private mode */ }
    }
  }, [])

  // Restore once the grid is on screen.
  const restored = useRef(false)
  useLayoutEffect(() => {
    if (restored.current || !items) return
    restored.current = true
    if (saved.current?.y) window.scrollTo(0, saved.current.y)
  }, [items])

  // A new search / filter / category starts again from the first page (but not
  // the first render — that may be a restored view).
  const filterKey = `${categoryId}|${q}|${tag}|${minP}|${maxP}|${sort}`
  const prevFilterKey = useRef(filterKey)
  useEffect(() => {
    if (prevFilterKey.current === filterKey) return
    prevFilterKey.current = filterKey
    setShown(PAGE)
  }, [filterKey])

  const catName = useMemo(
    () => Object.fromEntries(categories.map((c) => [c.id, c.name])),
    [categories],
  )

  // Distinct tags across the in-stock catalogue, for the filter chips.
  const allTags = useMemo(() => {
    const set = new Set()
    ;(items || []).forEach((i) => (i.tags || []).forEach((t) => set.add(t)))
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [items])

  // Price bands from the catalogue's own spread, at the rate THIS viewer pays
  // (dealers filter on dealer_rate — Golden Rule #4).
  const bands = useMemo(() => priceBands((items || []).map((i) => rateForBuyer(i, role))), [items, role])

  const visible = useMemo(() => {
    if (!items) return []
    const needle = q.trim().toLowerCase()
    const lo = minP === '' ? null : Number(minP)
    const hi = maxP === '' ? null : Number(maxP)
    const out = items.filter((i) => {
      if (categoryId && i.category_id !== categoryId) return false
      if (tag && !(i.tags || []).includes(tag)) return false
      if (lo !== null || hi !== null) {
        const price = rateForBuyer(i, role)
        if (lo !== null && price < lo) return false
        if (hi !== null && price > hi) return false
      }
      if (needle) {
        const hay = `${i.name} ${(i.tags || []).join(' ')} ${i.description || ''} ${i.company_no || ''}`.toLowerCase()
        if (!hay.includes(needle)) return false
      }
      return true
    })
    if (sort === 'price-asc') out.sort((a, b) => rateForBuyer(a, role) - rateForBuyer(b, role))
    else if (sort === 'price-desc') out.sort((a, b) => rateForBuyer(b, role) - rateForBuyer(a, role))
    else if (sort === 'new') out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    return out
  }, [items, categoryId, q, tag, minP, maxP, sort, role])

  // Set / clear URL params without adding a history entry per tap.
  function setParam(patch) {
    setParams((p) => {
      const next = new URLSearchParams(p)
      Object.entries(patch).forEach(([k, v]) => (v ? next.set(k, v) : next.delete(k)))
      return next
    }, { replace: true })
  }
  const setCategory = (id) => navigate({ pathname: id ? `/shop/${id}` : '/', search: params.toString() })

  const priceLabel = bandLabel(minP, maxP, currency)
  const filterCount = (tag ? 1 : 0) + (priceLabel ? 1 : 0)
  const hasFilters = allTags.length > 0 || bands.length > 1
  const clearFilters = () => setParam({ tag: '', min: '', max: '' })
  const activeCatName = categoryId ? catName[categoryId] : null

  return (
    <div className="space-y-4 sm:space-y-5">
      <h1 className={activeCatName ? 'font-[var(--font-display)] text-2xl font-bold text-ink sm:text-3xl' : 'sr-only'}>
        {activeCatName || shop?.name || 'Shop'}
      </h1>

      {!categoryId && !q && <BannerCarousel banners={shop?.banners} navigate={navigate} />}

      {/* Categories — one swipeable row, the only category control. */}
      {categories.length > 0 && (
        <nav aria-label="Categories" className="no-scrollbar -mx-4 flex snap-x scroll-px-4 gap-2 overflow-x-auto px-4 sm:-mx-6 sm:scroll-px-6 sm:px-6">
          <Pill active={!categoryId} onClick={() => setCategory('')}>All</Pill>
          {categories.map((c) => (
            <Pill key={c.id} active={categoryId === c.id} onClick={() => setCategory(c.id)}>{c.name}</Pill>
          ))}
        </nav>
      )}

      {/* Toolbar: count · sort · filter */}
      <div className="relative flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-sm text-muted" aria-live="polite">
          {items && (
            <>
              <span className="fig font-semibold text-ink">{visible.length}</span>{' '}
              {visible.length === 1 ? 'item' : 'items'}
              {q && <> for “<span className="text-ink">{q}</span>”</>}
              {role === 'dealer' && <> · Dealer prices</>}
            </>
          )}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <label className="sr-only" htmlFor="shop-sort">Sort by</label>
          <select
            id="shop-sort"
            value={sort}
            onChange={(e) => setParam({ sort: e.target.value })}
            className="h-11 rounded-lg border border-line bg-card pl-3 pr-8 text-sm font-medium text-ink outline-none transition-colors duration-150 hover:border-ink/25 focus-visible:border-peacock focus-visible:ring-1 focus-visible:ring-peacock"
          >
            {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
          {hasFilters && (
            <button
              type="button"
              onClick={() => setShowFilters(true)}
              aria-haspopup="dialog"
              aria-expanded={showFilters}
              className={`inline-flex h-11 items-center gap-2 rounded-lg border px-3 text-sm font-medium transition-colors duration-150 ${
                filterCount ? 'border-ink bg-ink text-white' : 'border-line bg-card text-ink hover:border-ink/25'
              }`}
            >
              <IconAdjustmentsHorizontal size={18} aria-hidden />
              Filter{filterCount > 0 && <span className="fig">({filterCount})</span>}
            </button>
          )}
        </div>

        {showFilters && (
          <FilterSheet
            onClose={() => setShowFilters(false)}
            tags={allTags} tag={tag} bands={bands} minP={minP} maxP={maxP}
            currency={currency} count={visible.length}
            setParam={setParam} clear={clearFilters} filterCount={filterCount}
          />
        )}
      </div>

      {/* Active filters — each removable where it's shown. */}
      {filterCount > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {tag && <ActiveChip onRemove={() => setParam({ tag: '' })}>{tag}</ActiveChip>}
          {priceLabel && <ActiveChip onRemove={() => setParam({ min: '', max: '' })}>{priceLabel}</ActiveChip>}
          <button type="button" onClick={clearFilters} className="h-9 px-2 text-sm font-medium text-muted hover:text-ink">
            Clear all
          </button>
        </div>
      )}

      {err ? (
        <State
          title="Couldn’t load the shop"
          body="Check your internet connection and try again."
          action={<button type="button" onClick={() => setReload((n) => n + 1)} className={outlineBtn}><IconRefresh size={18} /> Try again</button>}
        />
      ) : items === null ? (
        <SkeletonGrid />
      ) : visible.length === 0 ? (
        items.length === 0 ? (
          <State title="Nothing in stock right now" body="New stock arrives often — please check back soon." />
        ) : (
          <State
            icon={<IconSearch size={32} stroke={1.4} />}
            title="No products match"
            body={q ? 'Try a shorter or different search word.' : 'Try another category or remove a filter.'}
            action={(q || filterCount > 0 || categoryId) && (
              <button type="button" onClick={() => navigate('/')} className={outlineBtn}>Show all products</button>
            )}
          />
        )
      ) : (
        <>
          <Grid>
            {visible.slice(0, shown).map((item, i) => (
              <ItemCard key={item.id} item={item} priority={i < 4} />
            ))}
          </Grid>
          {visible.length > shown && (
            <div className="flex flex-col items-center gap-2 pt-4">
              <button type="button" onClick={() => setShown((n) => n + PAGE)} className={outlineBtn}>
                Show more
              </button>
              <p className="text-xs text-muted">
                Showing <span className="fig">{shown}</span> of <span className="fig">{visible.length}</span>
              </p>
            </div>
          )}
        </>
      )}
    </div>
  )
}

const outlineBtn =
  'inline-flex h-11 items-center gap-2 rounded-lg border border-line bg-card px-5 text-sm font-semibold text-ink transition-colors duration-150 hover:border-ink/30'

function Grid({ children }) {
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-6 sm:grid-cols-3 sm:gap-x-5 lg:grid-cols-4 xl:grid-cols-5">
      {children}
    </div>
  )
}

// Placeholder tiles in the grid's own shape, so the page doesn't jump when the
// catalogue arrives.
function SkeletonGrid() {
  return (
    <Grid>
      {Array.from({ length: 10 }, (_, i) => (
        <div key={i} className="animate-pulse" aria-hidden>
          <div className="aspect-square rounded-xl bg-paper-2" />
          <div className="mt-3 h-4 w-4/5 rounded bg-paper-2" />
          <div className="mt-2 h-4 w-1/3 rounded bg-paper-2" />
        </div>
      ))}
      <span className="sr-only" role="status">Loading products…</span>
    </Grid>
  )
}

function State({ icon, title, body, action }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
      {icon && <span className="mb-1 text-muted">{icon}</span>}
      <p className="font-semibold text-ink">{title}</p>
      <p className="max-w-sm text-sm text-muted">{body}</p>
      {action && <div className="mt-3">{action}</div>}
    </div>
  )
}

function Pill({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      className={`h-10 shrink-0 snap-start rounded-full px-4 text-sm font-medium transition-colors duration-150 ${
        active ? 'bg-ink text-white' : 'border border-line bg-card text-ink/80 hover:border-ink/30 hover:text-ink'
      }`}
    >
      {children}
    </button>
  )
}

function ActiveChip({ onRemove, children }) {
  return (
    <span className="inline-flex h-9 items-center gap-1 rounded-full bg-paper-2 pl-3 pr-1 text-sm text-ink">
      {children}
      <button type="button" onClick={onRemove} aria-label={`Remove filter ${children}`}
              className="grid h-7 w-7 place-items-center rounded-full text-muted hover:bg-card hover:text-ink">
        <IconX size={15} />
      </button>
    </span>
  )
}

// Filters: a bottom sheet on phones, a popover under the toolbar from sm up.
// Changes apply live; the button just closes it, showing the result count.
function FilterSheet({ onClose, tags, tag, bands, minP, maxP, currency, count, setParam, clear, filterCount }) {
  const panel = useRef(null)
  useEffect(() => {
    panel.current?.focus()
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <>
      <div className="fixed inset-0 z-40 bg-ink/30 sm:bg-transparent" onClick={onClose} aria-hidden />
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="filter-title"
        className="fixed inset-x-0 bottom-0 z-50 max-h-[80vh] overflow-y-auto rounded-t-2xl bg-card px-5 pt-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-xl outline-none sm:absolute sm:inset-x-auto sm:bottom-auto sm:right-0 sm:top-full sm:mt-2 sm:w-96 sm:rounded-xl sm:border sm:border-line sm:shadow-lg"
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-line sm:hidden" aria-hidden />
        <div className="flex items-center justify-between">
          <h2 id="filter-title" className="font-semibold text-ink">Filter</h2>
          <button type="button" onClick={onClose} aria-label="Close filters"
                  className="-mr-2 grid h-11 w-11 place-items-center rounded-lg text-muted hover:text-ink">
            <IconX size={20} />
          </button>
        </div>

        {bands.length > 1 && (
          <fieldset className="mt-3">
            <legend className="mb-2 text-sm font-medium text-ink">Price</legend>
            <div className="flex flex-wrap gap-2">
              {bands.map((b) => {
                const on = String(b.min ?? '') === minP && String(b.max ?? '') === maxP
                return (
                  <Option key={`${b.min}-${b.max}`} on={on}
                          onClick={() => setParam(on ? { min: '', max: '' } : { min: b.min == null ? '' : String(b.min), max: b.max == null ? '' : String(b.max) })}>
                    {bandLabel(b.min == null ? '' : String(b.min), b.max == null ? '' : String(b.max), currency)}
                  </Option>
                )
              })}
            </div>
          </fieldset>
        )}

        {tags.length > 0 && (
          <fieldset className="mt-5">
            <legend className="mb-2 text-sm font-medium text-ink">Type</legend>
            <div className="flex flex-wrap gap-2">
              {tags.map((t) => (
                <Option key={t} on={tag === t} onClick={() => setParam({ tag: tag === t ? '' : t })}>{t}</Option>
              ))}
            </div>
          </fieldset>
        )}

        <div className="mt-6 flex items-center gap-3">
          {filterCount > 0 && (
            <button type="button" onClick={clear} className="h-11 px-2 text-sm font-medium text-muted hover:text-ink">
              Clear
            </button>
          )}
          <button type="button" onClick={onClose}
                  className="h-11 flex-1 rounded-lg bg-peacock text-sm font-semibold text-white transition-colors duration-150 hover:bg-peacock-700">
            Show <span className="fig">{count}</span> {count === 1 ? 'item' : 'items'}
          </button>
        </div>
      </div>
    </>
  )
}

function Option({ on, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`h-10 rounded-full border px-3.5 text-sm transition-colors duration-150 ${
        on ? 'border-ink bg-ink text-white' : 'border-line bg-card text-ink/80 hover:border-ink/30'
      }`}
    >
      {children}
    </button>
  )
}

// Up to four price bands split at the catalogue's quartiles, rounded to tidy
// numbers (₹50, ₹200, ₹1,000…). One band means prices are too close to split.
function priceBands(prices) {
  const p = prices.filter(Number.isFinite).sort((a, b) => a - b)
  if (p.length < 8) return []
  const tidy = (n) => {
    const step = n < 100 ? 10 : n < 1000 ? 50 : n < 5000 ? 100 : 500
    return Math.max(step, Math.round(n / step) * step)
  }
  const cuts = [...new Set([0.25, 0.5, 0.75].map((f) => tidy(p[Math.floor(p.length * f)])))]
    .filter((c) => c > p[0] && c < p[p.length - 1])
  if (cuts.length === 0) return []
  const edges = [null, ...cuts, null]
  return edges.slice(0, -1).map((min, i) => ({ min, max: edges[i + 1] }))
}

function bandLabel(min, max, currency) {
  const c = (n) => money(n).replace(/\.00$/, '').replace('₹', currency)
  if (min && max) return `${c(min)} – ${c(max)}`
  if (max) return `Under ${c(max)}`
  if (min) return `${c(min)} and above`
  return ''
}

// Banner slides from shops.banners (Settings). Native swipe via scroll-snap;
// auto-advances every 5s unless the buyer is interacting, the tab is hidden, or
// they prefer reduced motion. A slide with a `link` is clickable — internal
// links ("/shop/…") route in-app; anything else opens in a new tab.
function BannerCarousel({ banners, navigate }) {
  const slides = Array.isArray(banners) ? banners.filter((b) => b?.image_url) : []
  const rail = useRef(null)
  const [i, setI] = useState(0)
  const [paused, setPaused] = useState(false)

  useEffect(() => {
    if (slides.length < 2 || paused) return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const t = setInterval(() => {
      const el = rail.current
      if (!el || document.hidden) return
      const next = (Math.round(el.scrollLeft / el.clientWidth) + 1) % slides.length
      el.scrollTo({ left: next * el.clientWidth, behavior: 'smooth' })
    }, 5000)
    return () => clearInterval(t)
  }, [slides.length, paused])

  if (slides.length === 0) return null

  const open = (link) => {
    if (!link) return
    if (link.startsWith('/')) navigate(link)
    else window.open(link, '_blank', 'noopener,noreferrer')
  }
  const go = (n) => rail.current?.scrollTo({ left: n * rail.current.clientWidth, behavior: 'smooth' })

  return (
    <section
      aria-roledescription="carousel"
      aria-label="Offers"
      className="relative"
      onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}
      onTouchStart={() => setPaused(true)}
    >
      <div
        ref={rail}
        onScroll={(e) => setI(Math.round(e.currentTarget.scrollLeft / e.currentTarget.clientWidth))}
        className="no-scrollbar flex snap-x snap-mandatory overflow-x-auto rounded-xl bg-paper-2"
      >
        {slides.map((b, idx) => {
          const body = (
            <>
              <Img src={b.image_url} eager={idx === 0} alt={b.caption || ''} className="h-full w-full object-cover" />
              {b.caption && (
                <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-ink/60 to-transparent px-5 pb-4 pt-10 text-left text-base font-semibold text-white sm:px-7 sm:text-lg">
                  {b.caption}
                </span>
              )}
            </>
          )
          const cls = 'relative block aspect-[2/1] w-full shrink-0 snap-center sm:aspect-[3/1]'
          return b.link ? (
            <button key={idx} type="button" onClick={() => open(b.link)} className={cls} aria-label={b.caption || `Offer ${idx + 1}`}>
              {body}
            </button>
          ) : (
            <div key={idx} className={cls}>{body}</div>
          )
        })}
      </div>

      {slides.length > 1 && (
        <div className="absolute inset-x-0 bottom-1 flex justify-center">
          {slides.map((_, idx) => (
            <button key={idx} type="button" onClick={() => go(idx)} aria-label={`Show offer ${idx + 1}`}
                    aria-current={idx === i ? 'true' : undefined}
                    className="grid h-6 w-6 place-items-center">
              <span className={`h-1.5 rounded-full transition-all duration-150 ${idx === i ? 'w-4 bg-white' : 'w-1.5 bg-white/60'}`} />
            </button>
          ))}
        </div>
      )}
    </section>
  )
}
