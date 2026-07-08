import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  IconSearch, IconPlus, IconPencil, IconPhoto, IconX, IconCircleCheck, IconCamera,
  IconDotsVertical, IconBarcode, IconPrinter, IconArchive, IconArchiveOff, IconAlertTriangle,
} from '@tabler/icons-react'
import { supabase } from '../../lib/supabase'
import { useShop } from '../../context/ShopContext'
import { money, qty } from '../../lib/format'
import { round2, stockValue } from '../../lib/helpers'
import { printBarcodeLabels, barcodeValue, DEFAULT_LABEL_OPTS } from '../../lib/barcodeLabel'
import { Button, Field, Select, Textarea, StockBadge, Badge, Spinner, TagsInput, ImagesInput } from '../../components/ui'

// SPEC §6.2 — Inventory master list. Owner sees all items, searches/filters,
// and edits any field including quantity (direct stock correction; new stock-in
// with supplier billing still goes via Purchase Entry). Total stock value
// (owner only) sits at the top.
export default function Inventory() {
  const { categories, suppliers, currency, shop } = useShop()
  const [items, setItems] = useState(null)
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')
  const [cat, setCat] = useState('')
  const [sup, setSup] = useState('')
  const [tag, setTag] = useState('')
  const [show, setShow] = useState('active') // active | inactive | all
  const [lowOnly, setLowOnly] = useState(false)
  const [editing, setEditing] = useState(null)
  const [printing, setPrinting] = useState(null) // item whose barcode label we're printing
  const [retiring, setRetiring] = useState(null) // item pending discontinue / reactivate confirm
  const [zoom, setZoom] = useState(null) // photo_url shown full-size in a lightbox

  async function load() {
    setErr('')
    const { data, error } = await supabase
      .from('items')
      .select(
        'id, item_no, name, location, quantity, purchase_rate, dealer_rate, rate, ' +
          'low_stock_threshold, moq, barcode, hsn_sac, photo_url, is_active, discontinued, discontinued_at, made_to_order, supplier_id, category_id, ' +
          'description, tags, images, ' +
          'supplier:suppliers(name), category:categories(name)',
      )
      .order('item_no')
    if (error) setErr(error.message)
    else setItems(data ?? [])
  }
  useEffect(() => { load() }, [])

  // All distinct tags across items, for the tag filter dropdown.
  const allTags = useMemo(() => {
    if (!items) return []
    const set = new Set()
    items.forEach((i) => (i.tags || []).forEach((t) => set.add(t)))
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [items])

  const filtered = useMemo(() => {
    if (!items) return []
    const needle = q.trim().toLowerCase()
    return items.filter((i) => {
      // `show` blends the two independent flags into one plain-language filter:
      // live items (not discontinued) split by shopfront visibility, plus a
      // dedicated bucket for retired lines.
      if (show === 'active' && (!i.is_active || i.discontinued)) return false
      if (show === 'inactive' && (i.is_active || i.discontinued)) return false
      if (show === 'discontinued' && !i.discontinued) return false
      if (show === 'mto' && !i.made_to_order) return false
      if (cat && i.category_id !== cat) return false
      if (sup && i.supplier_id !== sup) return false
      if (tag && !(i.tags || []).includes(tag)) return false
      if (lowOnly && !(Number(i.quantity) < Number(i.low_stock_threshold))) return false
      if (needle) {
        const hay = `${i.item_no} ${i.name} ${i.barcode || ''} ${i.supplier?.name || ''} ${i.category?.name || ''} ${(i.tags || []).join(' ')} ${i.description || ''}`.toLowerCase()
        if (!hay.includes(needle)) return false
      }
      return true
    })
  }, [items, q, cat, sup, tag, show, lowOnly])

  const totalValue = useMemo(
    () => (items ? items.reduce((s, i) => s + stockValue(i), 0) : 0),
    [items],
  )

  return (
    <div className="space-y-5">
      {/* Top bar: total value + new item */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="rounded-lg border border-line bg-card px-5 py-3">
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
      <div className="grid gap-3 rounded-lg border border-line bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="relative sm:col-span-2 lg:col-span-1">
          <IconSearch size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, Item No, barcode…"
            className="w-full rounded-lg border border-line bg-card py-2.5 pl-9 pr-3 text-ink outline-none focus:border-peacock focus:ring-1 focus:ring-peacock"
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
        {allTags.length > 0 && (
          <Select value={tag} onChange={(e) => setTag(e.target.value)}>
            <option value="">All tags</option>
            {allTags.map((t) => <option key={t} value={t}>{t}</option>)}
          </Select>
        )}
        <div className="flex items-center gap-2">
          <Select value={show} onChange={(e) => setShow(e.target.value)} className="flex-1">
            <option value="all">All</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="discontinued">Discontinued</option>
            <option value="mto">Make to Order</option>
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
        <div className="overflow-hidden rounded-lg border border-line bg-card">
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
                        <Thumb url={i.photo_url} onZoom={() => setZoom(i.photo_url)} />
                        <div className="min-w-0">
                          <p className="truncate font-medium text-ink">
                            {i.name}
                            {i.discontinued
                              ? <Badge className="ml-2" tone="dues">Discontinued</Badge>
                              : !i.is_active && <Badge className="ml-2" tone="muted">Inactive</Badge>}
                          </p>
                          <p className="fig text-xs text-muted">
                            {i.item_no} · {i.supplier?.name || '—'}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted">{i.category?.name || '—'}</td>
                    <td className="px-4 py-3 text-right">
                      {i.made_to_order ? (
                        <Badge tone="peacock">Make to Order</Badge>
                      ) : (
                        <div className="flex items-center justify-end gap-2">
                          <span className="fig">{qty(i.quantity)}</span>
                          <StockBadge quantity={i.quantity} threshold={i.low_stock_threshold} />
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right fig">{money(i.rate)}</td>
                    <td className="px-4 py-3 text-right fig text-muted">{money(stockValue(i))}</td>
                    <td className="px-4 py-3 text-right">
                      <RowActions
                        discontinued={i.discontinued}
                        onEdit={() => setEditing(i)}
                        onPrint={() => setPrinting(i)}
                        onDiscontinue={() => setRetiring(i)}
                      />
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

      {printing && (
        <PrintBarcodeModal
          item={printing}
          currency={currency}
          shopName={shop?.brand_text || shop?.name || ''}
          onClose={() => setPrinting(null)}
        />
      )}

      {retiring && (
        <DiscontinueModal
          item={retiring}
          onClose={() => setRetiring(null)}
          onDone={() => { setRetiring(null); load() }}
        />
      )}

      {zoom && <Lightbox url={zoom} onClose={() => setZoom(null)} />}
    </div>
  )
}

// Per-row "action dot" menu: a three-dot button that opens Edit + Print barcode.
function RowActions({ discontinued, onEdit, onPrint, onDiscontinue }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', (e) => e.key === 'Escape' && setOpen(false))
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  return (
    <div ref={ref} className="relative inline-block text-left">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Actions"
        className="inline-flex items-center justify-center rounded-lg border border-line p-1.5 text-muted hover:text-ink"
      >
        <IconDotsVertical size={16} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 w-44 overflow-hidden rounded-lg border border-line bg-card py-1 shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => { setOpen(false); onEdit() }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-ink hover:bg-paper-2"
          >
            <IconPencil size={15} className="text-muted" /> Edit
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => { setOpen(false); onPrint() }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-ink hover:bg-paper-2"
          >
            <IconBarcode size={15} className="text-muted" /> Print barcode
          </button>
          <div className="my-1 border-t border-line" />
          <button
            type="button"
            role="menuitem"
            onClick={() => { setOpen(false); onDiscontinue() }}
            className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-paper-2 ${
              discontinued ? 'text-profit' : 'text-dues'
            }`}
          >
            {discontinued
              ? <><IconArchiveOff size={15} /> Reactivate</>
              : <><IconArchive size={15} /> Discontinue</>}
          </button>
        </div>
      )}
    </div>
  )
}

// Confirms discontinuing (retiring) an item or bringing it back. Discontinuing
// only sets the flag — it never touches stock. If physical stock remains we warn
// the owner: the leftover is stranded from the shopfront but can still be sold at
// the Counter (POS) to clear it. Reactivating just clears the flag.
function DiscontinueModal({ item, onClose, onDone }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const reactivating = item.discontinued
  const leftover = Number(item.quantity) || 0

  async function confirm() {
    setBusy(true); setErr('')
    const { error } = await supabase
      .from('items')
      .update(
        reactivating
          ? { discontinued: false, discontinued_at: null }
          : { discontinued: true, discontinued_at: new Date().toISOString() },
      )
      .eq('id', item.id)
    if (error) { setErr(error.message); setBusy(false); return }
    onDone()
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/40 p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm space-y-4 rounded-lg border border-line bg-card p-6"
      >
        <div className="flex items-center gap-3">
          <div className={`grid h-10 w-10 shrink-0 place-items-center rounded-full ${reactivating ? 'bg-profit/10 text-profit' : 'bg-dues/10 text-dues'}`}>
            {reactivating ? <IconArchiveOff size={22} /> : <IconArchive size={22} />}
          </div>
          <div>
            <h3 className="font-[var(--font-display)] text-xl font-bold">
              {reactivating ? 'Reactivate item?' : 'Discontinue item?'}
            </h3>
            <p className="fig text-xs text-muted">{item.name} · {item.item_no}</p>
          </div>
        </div>

        {err && <p className="rounded-lg bg-dues/10 px-3 py-2 text-sm text-dues">{err}</p>}

        {reactivating ? (
          <p className="text-sm text-muted">
            This brings <span className="font-medium text-ink">{item.name}</span> back as a live product.
            It will show on the shopfront again (as long as it's marked active and in stock).
          </p>
        ) : (
          <>
            <p className="text-sm text-muted">
              <span className="font-medium text-ink">{item.name}</span> will be retired: removed from
              the shopfront and hidden from customers. Its sales history stays intact, and it can still
              be sold at the Counter to clear any stock left.
            </p>
            {leftover > 0 && (
              <p className="flex items-start gap-2 rounded-lg bg-saffron/10 px-3 py-2.5 text-sm text-saffron">
                <IconAlertTriangle size={18} className="mt-0.5 shrink-0" />
                <span>
                  This item still has <span className="fig font-semibold">{qty(leftover)}</span> in stock.
                  That stock will no longer be shown to customers. Discontinue anyway?
                </span>
              </p>
            )}
          </>
        )}

        <div className="flex justify-end gap-3 pt-1">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant={reactivating ? 'primary' : 'danger'}
            onClick={confirm}
            disabled={busy}
          >
            {busy ? <><Spinner /> Saving…</> : reactivating ? 'Reactivate' : 'Discontinue'}
          </Button>
        </div>
      </div>
    </div>
  )
}

// Asks how many label copies to print, then sends a 3-per-row, 3cm × 2cm sheet
// to the printer. Defaults to 3 copies — one full row on a terminal label roll.
function PrintBarcodeModal({ item, currency, shopName, onClose }) {
  const [copies, setCopies] = useState('3')
  const [opts, setOpts] = useState(DEFAULT_LABEL_OPTS)
  const value = barcodeValue(item)

  const toggle = (key) => (e) => setOpts((o) => ({ ...o, [key]: e.target.checked }))
  const setRate = (rate) => () => setOpts((o) => ({ ...o, rate }))

  function doPrint() {
    const n = Math.max(1, Math.min(100, Math.floor(Number(copies) || 0)))
    printBarcodeLabels(Array.from({ length: n }, () => item), { currency, shopName, labelOpts: opts })
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/40 p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm space-y-4 rounded-lg border border-line bg-card p-6"
      >
        <div className="flex items-center justify-between">
          <h3 className="inline-flex items-center gap-2 font-[var(--font-display)] text-xl font-bold">
            <IconBarcode size={22} /> Print barcode
          </h3>
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-muted hover:bg-paper-2">
            <IconX size={20} />
          </button>
        </div>

        <div className="rounded-lg bg-paper-2 px-4 py-3">
          <p className="font-medium text-ink">{item.name}</p>
          <p className="fig text-xs text-muted">
            {item.item_no}{value ? ` · code ${value}` : ''}
          </p>
        </div>

        {!value ? (
          <p className="rounded-lg bg-dues/10 px-3 py-2 text-sm text-dues">
            This item has no barcode or Item No yet. Add a barcode in Edit first.
          </p>
        ) : (
          <>
            <Field
              label="How many labels?"
              type="number"
              min="1"
              max="100"
              value={copies}
              onChange={(e) => setCopies(e.target.value)}
            />

            <div className="space-y-2 rounded-lg border border-line bg-paper-2 px-4 py-3">
              <span className="block text-sm font-medium text-ink">What's on the label?</span>
              <LabelCheck label="Company name" checked={opts.company} onChange={toggle('company')} />
              <LabelCheck label="Item name" checked={opts.itemName} onChange={toggle('itemName')} />
              <LabelCheck label="Barcode" checked={opts.barcode} onChange={toggle('barcode')} />
              <LabelCheck label="Item code" checked={opts.code} onChange={toggle('code')} />

              <span className="block pt-1 text-sm font-medium text-ink">Rate</span>
              <LabelRadio label="None" checked={opts.rate === 'none'} onChange={setRate('none')} />
              <LabelRadio label="Customer rate" checked={opts.rate === 'customer'} onChange={setRate('customer')} />
              <LabelRadio label="Dealer rate" checked={opts.rate === 'dealer'} onChange={setRate('dealer')} />
            </div>
          </>
        )}

        <p className="flex items-center gap-1.5 text-xs text-muted">
          <IconPrinter size={14} /> Labels print 3 to a row, each 3 × 2 cm.
        </p>

        <div className="flex justify-end gap-3 pt-1">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={doPrint} disabled={!value}>
            <IconPrinter size={18} /> Print
          </Button>
        </div>
      </div>
    </div>
  )
}

// Compact label-content toggles for the print modal. Same row styling for both;
// only the input type differs (checkbox = independent, radio = one-at-a-time).
function LabelCheck({ label, checked, onChange }) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 text-sm text-ink">
      <input type="checkbox" checked={checked} onChange={onChange}
        className="ring-focus h-4 w-4 rounded border-line accent-peacock" />
      {label}
    </label>
  )
}

function LabelRadio({ label, checked, onChange }) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 text-sm text-ink">
      <input type="radio" name="bc-rate" checked={checked} onChange={onChange}
        className="ring-focus h-4 w-4 border-line accent-peacock" />
      {label}
    </label>
  )
}

function Thumb({ url, onZoom }) {
  if (url) {
    return (
      <button
        type="button"
        onClick={onZoom}
        title="View photo"
        className="group h-14 w-14 shrink-0 overflow-hidden rounded-lg border border-line bg-paper-2 transition hover:ring-2 hover:ring-peacock/40"
      >
        <img
          src={url}
          alt=""
          className="h-full w-full object-cover transition group-hover:scale-105"
        />
      </button>
    )
  }
  return (
    <div className="grid h-14 w-14 shrink-0 place-items-center rounded-lg border border-line bg-paper-2 text-muted">
      <IconPhoto size={22} />
    </div>
  )
}

// Full-size photo overlay — click anywhere or the X to dismiss.
function Lightbox({ url, onClose }) {
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-ink/70 p-4"
      onClick={onClose}
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute right-4 top-4 rounded-lg bg-card/90 p-2 text-ink hover:bg-card"
      >
        <IconX size={22} />
      </button>
      <img
        src={url}
        alt=""
        onClick={(e) => e.stopPropagation()}
        className="max-h-[85vh] max-w-full rounded-lg border border-line object-contain shadow-2xl"
      />
    </div>
  )
}

function EditModal({ item, categories, suppliers, onClose, onSaved }) {
  const { shopId } = useShop()
  const [f, setF] = useState({
    name: item.name,
    supplier_id: item.supplier_id,
    category_id: item.category_id,
    location: item.location || '',
    quantity: String(item.quantity),
    purchase_rate: String(item.purchase_rate),
    dealer_rate: String(item.dealer_rate),
    rate: String(item.rate),
    low_stock_threshold: String(item.low_stock_threshold),
    moq: String(item.moq ?? 1),
    barcode: item.barcode || '',
    hsn_sac: item.hsn_sac || '',
    description: item.description || '',
    tags: item.tags || [],
    images: item.images || [],
    is_active: item.is_active,
    made_to_order: !!item.made_to_order,
  })
  // Photo: either upload a file (-> Storage) or paste an image URL. A picked
  // file wins over the URL field. photoUrl doubles as the current/preview src.
  const [photoFile, setPhotoFile] = useState(null)
  const [photoUrl, setPhotoUrl] = useState(item.photo_url || '')
  const [preview, setPreview] = useState(item.photo_url || '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }))

  function onPhotoFile(e) {
    const file = e.target.files?.[0]
    if (!file) return
    if (preview.startsWith('blob:')) URL.revokeObjectURL(preview)
    setPhotoFile(file)
    setPreview(URL.createObjectURL(file))
  }
  function onPhotoUrl(e) {
    const url = e.target.value
    setPhotoUrl(url)
    setPhotoFile(null)
    if (preview.startsWith('blob:')) URL.revokeObjectURL(preview)
    setPreview(url.trim())
  }
  function clearPhoto() {
    if (preview.startsWith('blob:')) URL.revokeObjectURL(preview)
    setPhotoFile(null)
    setPhotoUrl('')
    setPreview('')
  }

  async function uploadPhoto() {
    if (!photoFile) return photoUrl.trim() || null
    const ext = (photoFile.name.split('.').pop() || 'jpg').toLowerCase()
    const path = `${shopId}/${crypto.randomUUID()}.${ext}`
    const { error } = await supabase.storage
      .from('item-photos')
      .upload(path, photoFile, { upsert: false, contentType: photoFile.type })
    if (error) throw new Error('Photo upload failed: ' + error.message)
    return supabase.storage.from('item-photos').getPublicUrl(path).data.publicUrl
  }

  async function save(e) {
    e.preventDefault()
    if (!f.name.trim()) { setErr('Item name is required.'); return }
    setBusy(true); setErr('')
    try {
      const photo_url = await uploadPhoto()
      const { error } = await supabase
        .from('items')
        .update({
          name: f.name.trim(),
          supplier_id: f.supplier_id,
          category_id: f.category_id,
          location: f.location.trim() || null,
          quantity: round2(f.quantity || 0),
          purchase_rate: round2(f.purchase_rate),
          dealer_rate: round2(f.dealer_rate),
          rate: round2(f.rate),
          low_stock_threshold: round2(f.low_stock_threshold || 0),
          moq: round2(f.moq || 1),
          barcode: f.barcode.trim() || null,
          hsn_sac: f.hsn_sac.trim() || null,
          photo_url,
          description: f.description.trim() || null,
          tags: f.tags,
          images: f.images,
          is_active: f.is_active,
          made_to_order: f.made_to_order,
        })
        .eq('id', item.id)
      if (error) throw new Error(error.message)
      onSaved()
    } catch (e2) {
      setErr(e2.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/40 p-4 overflow-y-auto" onClick={onClose}>
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={save}
        className="my-8 w-full max-w-lg space-y-4 rounded-lg border border-line bg-card p-6"
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

        {/* Photo: upload a file OR paste an image link. Both optional. */}
        <div className="space-y-2">
          <p className="text-sm font-medium text-ink">Photo</p>
          <div className="flex flex-wrap items-start gap-4">
            <div className="h-24 w-24 shrink-0 overflow-hidden rounded-lg border border-line bg-paper-2">
              {preview ? (
                <img
                  src={preview}
                  alt="preview"
                  className="h-full w-full object-cover"
                  onError={() => setPreview('')}
                />
              ) : (
                <div className="grid h-full w-full place-items-center text-muted">
                  <IconPhoto size={24} />
                </div>
              )}
            </div>
            <div className="min-w-[12rem] flex-1 space-y-2">
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-line bg-card px-4 py-2.5 text-sm font-semibold hover:bg-paper-2">
                <IconCamera size={18} /> {preview ? 'Change photo' : 'Add photo'}
                <input type="file" accept="image/*" capture="environment" className="hidden" onChange={onPhotoFile} />
              </label>
              <Field
                label="Or paste image URL"
                placeholder="https://…"
                value={photoFile ? '' : photoUrl}
                onChange={onPhotoUrl}
                disabled={!!photoFile}
              />
              {preview && (
                <button type="button" onClick={clearPhoto}
                        className="inline-flex items-center gap-1 text-xs text-dues hover:underline">
                  <IconX size={14} /> Remove photo
                </button>
              )}
            </div>
          </div>
        </div>

        <Field label="Item name" value={f.name} onChange={set('name')} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Select label="Company / Supplier" value={f.supplier_id} onChange={set('supplier_id')}>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
          <Select label="Category" value={f.category_id} onChange={set('category_id')}>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Location / Rack No" value={f.location} onChange={set('location')} />
          <Field label="Low stock threshold" type="number" min="0" value={f.low_stock_threshold} onChange={set('low_stock_threshold')} />
          <Field label="Min order qty (MOQ)" type="number" min="1" value={f.moq} onChange={set('moq')} hint="Least a customer can order" />
        </div>
        {!f.made_to_order && (
          <Field label="Stock quantity" type="number" min="0" step="0.01" value={f.quantity} onChange={set('quantity')}
                 hint="Current stock on hand — edit to correct it directly." />
        )}
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Purchase Rate" prefix="₹" type="number" min="0" step="0.01" value={f.purchase_rate} onChange={set('purchase_rate')} />
          <Field label="Dealer Rate" prefix="₹" type="number" min="0" step="0.01" value={f.dealer_rate} onChange={set('dealer_rate')} />
          <Field label="Rate (retail)" prefix="₹" type="number" min="0" step="0.01" value={f.rate} onChange={set('rate')} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Barcode / QR" value={f.barcode} onChange={set('barcode')} />
          <Field label="HSN / SAC code" value={f.hsn_sac} onChange={set('hsn_sac')}
                 hint="Optional. Printed on the tax invoice." />
        </div>

        <Textarea
          label="Description" rows={3} value={f.description}
          onChange={set('description')}
          placeholder="Shown on the shopfront item page — material, size, occasion…"
        />
        <TagsInput
          label="Tags" value={f.tags}
          onChange={(tags) => setF((s) => ({ ...s, tags }))}
          hint="Used for search & filtering, e.g. wedding, premium, handmade."
        />
        <ImagesInput
          label="More photos (gallery)" value={f.images}
          onChange={(images) => setF((s) => ({ ...s, images }))}
          hint="Extra images shown on the item page. The photo above stays the cover."
        />

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

        <div className="flex items-center justify-between rounded-lg bg-paper-2 px-4 py-3">
          <div>
            <p className="text-sm font-medium">Make to Order (no stock limit)</p>
            <p className="text-xs text-muted">Always shown on the shopfront; buyers order any quantity. Cost is set when you approve.</p>
          </div>
          <button
            type="button"
            onClick={() => setF((s) => ({ ...s, made_to_order: !s.made_to_order }))}
            className={`relative h-6 w-11 shrink-0 rounded-full transition ${f.made_to_order ? 'bg-peacock' : 'bg-line'}`}
            aria-pressed={f.made_to_order}
          >
            <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-card transition ${f.made_to_order ? 'left-[1.375rem]' : 'left-0.5'}`} />
          </button>
        </div>

        <p className="flex items-center gap-1.5 text-xs text-muted">
          <IconCircleCheck size={14} className="text-profit" />
          For new stock-in with supplier billing, use Purchase Entry. Editing the quantity here corrects stock directly.
        </p>

        <div className="flex justify-end gap-3 pt-1">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? <><Spinner /> Saving…</> : 'Save changes'}</Button>
        </div>
      </form>
    </div>
  )
}
