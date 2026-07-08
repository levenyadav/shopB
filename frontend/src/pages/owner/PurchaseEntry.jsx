import { useEffect, useState } from 'react'
import { Link, useSearchParams, useNavigate } from 'react-router-dom'
import {
  IconCamera, IconPlus, IconBarcode, IconCircleCheck, IconX, IconFileSpreadsheet,
  IconScan, IconCircleArrowRight,
} from '@tabler/icons-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import { useShop } from '../../context/ShopContext'
import { money, qty } from '../../lib/format'
import { round2 } from '../../lib/helpers'
import { Button, Field, Select, Textarea, Spinner, StockBadge, TagsInput, ImagesInput } from '../../components/ui'
import BarcodeScanner from '../../components/BarcodeScanner'

// Public barcode → product lookup (Open Food Facts; free, keyless, CORS-friendly).
// Only used as a fallback when a scanned code is NOT already in the shop's own
// catalogue. Most custom cards/boxes won't be found here, so callers must treat
// a null result as "unknown — create a new item from scratch".
async function lookupPublicProduct(code) {
  try {
    const res = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json` +
        `?fields=product_name,brands,image_front_url,image_url`,
    )
    if (!res.ok) return null
    const json = await res.json()
    if (json?.status !== 1 || !json.product) return null
    const p = json.product
    const name = (p.product_name || '').trim()
    if (!name) return null
    return {
      name,
      brand: (p.brands || '').split(',')[0]?.trim() || '',
      image: p.image_front_url || p.image_url || '',
    }
  } catch {
    return null
  }
}

// SPEC §6.1 / §6.9 — Purchase Entry, two modes:
//   • new item       → /owner/purchase           (create item + opening stock)
//   • restock        → /owner/purchase?item=<id> (add stock to an existing item)
// Both honour Golden Rule #1: stock only ever rises via a purchases row, whose
// trigger raises items.quantity, the supplier balance and the ledger.
export default function PurchaseEntry() {
  const [params] = useSearchParams()
  const itemId = params.get('item')
  return itemId ? <RestockEntry itemId={itemId} /> : <NewItemEntry />
}

const BLANK = {
  name: '', supplier_id: '', category_id: '', location: '',
  quantity: '', purchase_rate: '', dealer_rate: '', rate: '',
  low_stock_threshold: '10', moq: '1', barcode: '', notes: '',
  description: '', tags: [], images: [], made_to_order: false,
}

function NewItemEntry() {
  const { profile } = useAuth()
  const { shopId, categories, suppliers, refreshSuppliers } = useShop()
  const navigate = useNavigate()

  const [form, setForm] = useState(BLANK)
  const [photoFile, setPhotoFile] = useState(null)
  const [photoPreview, setPhotoPreview] = useState('')
  const [scannedPhotoUrl, setScannedPhotoUrl] = useState('') // external image from a scan
  const [errors, setErrors] = useState({})
  const [busy, setBusy] = useState(false)
  const [topError, setTopError] = useState('')
  const [done, setDone] = useState(null) // { item_no, name, quantity, total_cost }
  const [showSupplier, setShowSupplier] = useState(false)
  const [showScanner, setShowScanner] = useState(false)
  const [scanBusy, setScanBusy] = useState(false)
  const [scanInfo, setScanInfo] = useState(null) // { tone, item?, name? }

  const set = (k) => (e) => {
    setForm((f) => ({ ...f, [k]: e.target.value }))
    setErrors((er) => ({ ...er, [k]: undefined }))
  }

  function onPhoto(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setPhotoFile(file)
    setPhotoPreview(URL.createObjectURL(file))
  }

  function clearPhoto() {
    setPhotoFile(null)
    if (photoPreview) URL.revokeObjectURL(photoPreview)
    setPhotoPreview('')
    setScannedPhotoUrl('')
  }

  function generateBarcode() {
    // Local fallback code (QR image generation is a Phase-3 edge function, §14.1).
    const code = 'SC' + Date.now().toString(36).toUpperCase()
    setForm((f) => ({ ...f, barcode: code }))
  }

  // A code was scanned (or typed in the scanner). Resolve it against real data:
  //  1) our own catalogue → it's a restock; offer to jump straight to Restock.
  //  2) else a public product DB → prefill name + photo for a brand-new item.
  //  3) else just drop the code into the field to fill the rest manually.
  async function handleDetected(code) {
    setShowScanner(false)
    setScanBusy(true)
    setScanInfo(null)
    setForm((f) => ({ ...f, barcode: code }))
    setErrors((er) => ({ ...er, barcode: undefined }))
    try {
      const { data: existing } = await supabase
        .from('items')
        .select('id, item_no, name, quantity, low_stock_threshold')
        .eq('shop_id', shopId)
        .eq('barcode', code)
        .maybeSingle()

      if (existing) {
        setScanInfo({ tone: 'found', item: existing })
        return
      }

      const found = await lookupPublicProduct(code)
      if (found) {
        setForm((f) => ({ ...f, name: f.name.trim() || found.name }))
        setErrors((er) => ({ ...er, name: undefined }))
        if (found.image) {
          setPhotoFile(null)
          if (photoPreview) URL.revokeObjectURL(photoPreview)
          setPhotoPreview('')
          setScannedPhotoUrl(found.image)
        }
        setScanInfo({ tone: 'api', name: found.name })
      } else {
        setScanInfo({ tone: 'none' })
      }
    } catch {
      setScanInfo({ tone: 'none' })
    } finally {
      setScanBusy(false)
    }
  }

  function validate() {
    const e = {}
    if (!form.name.trim()) e.name = 'Item name is required.'
    if (!form.supplier_id) e.supplier_id = 'Choose a company / supplier.'
    if (!form.category_id) e.category_id = 'Choose a category.'
    // Made-to-order items carry no opening stock and no cost yet (cost is set by
    // the owner at approval), so quantity/purchase rate are not required for them.
    if (!form.made_to_order) {
      const q = Number(form.quantity)
      if (!form.quantity || q <= 0) e.quantity = 'Enter how many came in.'
      if (form.purchase_rate === '' || Number(form.purchase_rate) < 0) e.purchase_rate = 'Enter the cost rate.'
    }
    if (form.dealer_rate === '' || Number(form.dealer_rate) < 0) e.dealer_rate = 'Enter the dealer rate.'
    if (form.rate === '' || Number(form.rate) < 0) e.rate = 'Enter the retail rate.'
    if (form.moq !== '' && Number(form.moq) < 1) e.moq = 'MOQ must be at least 1.'
    setErrors(e)
    return Object.keys(e).length === 0
  }

  async function uploadPhoto() {
    if (!photoFile) return null
    const ext = (photoFile.name.split('.').pop() || 'jpg').toLowerCase()
    const path = `${shopId}/${crypto.randomUUID()}.${ext}`
    const { error } = await supabase.storage
      .from('item-photos')
      .upload(path, photoFile, { upsert: false, contentType: photoFile.type })
    if (error) throw new Error('Photo upload failed: ' + error.message)
    return supabase.storage.from('item-photos').getPublicUrl(path).data.publicUrl
  }

  async function onSubmit(e) {
    e.preventDefault()
    setTopError('')
    if (!validate()) return
    setBusy(true)
    try {
      const photo_url = (await uploadPhoto()) || scannedPhotoUrl || null
      const mto = form.made_to_order
      const quantity = mto ? 0 : round2(form.quantity)
      // Made-to-order carries no cost yet — the owner enters it at approval; use 0
      // as the placeholder on the catalogue row (never shown to buyers anyway).
      const purchase_rate = mto ? 0 : round2(form.purchase_rate)

      // 1) create the catalogue item with NO opening stock
      const { data: item, error: itemErr } = await supabase
        .from('items')
        .insert({
          shop_id: shopId,
          name: form.name.trim(),
          supplier_id: form.supplier_id,
          category_id: form.category_id,
          location: form.location.trim() || null,
          quantity: 0,
          purchase_rate,
          dealer_rate: round2(form.dealer_rate),
          rate: round2(form.rate),
          low_stock_threshold: round2(form.low_stock_threshold || 10),
          moq: round2(form.moq || 1),
          barcode: form.barcode.trim() || null,
          photo_url,
          description: form.description.trim() || null,
          tags: form.tags,
          images: form.images,
          made_to_order: mto,
        })
        .select('id, item_no, name')
        .single()
      if (itemErr) throw new Error(itemErr.message)

      // 2) record the opening purchase -> trigger raises stock + supplier + ledger.
      //    Made-to-order items hold no stock, so there is no opening purchase.
      const total_cost = round2(quantity * purchase_rate)
      if (!mto) {
        const { error: pErr } = await supabase.from('purchases').insert({
          shop_id: shopId,
          item_id: item.id,
          supplier_id: form.supplier_id,
          quantity,
          purchase_rate,
          total_cost,
          entered_by: profile.id,
          notes: form.notes.trim() || null,
        })
        if (pErr) {
          throw new Error(
            `Item ${item.item_no} was created, but recording the stock-in failed: ${pErr.message}. ` +
              `Restock it from Inventory.`,
          )
        }
      }

      setDone({ item_no: item.item_no, name: item.name, quantity, total_cost, made_to_order: mto })
      setForm(BLANK)
      clearPhoto()
      setErrors({})
      setScanInfo(null)
    } catch (err) {
      setTopError(err.message || 'Could not save. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  const liveCost =
    form.quantity && form.purchase_rate
      ? round2(Number(form.quantity) * Number(form.purchase_rate))
      : null

  if (done) return <Success done={done} onAnother={() => setDone(null)} />

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-4 flex justify-end">
        <Link to="/owner/bulk-purchase"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-peacock hover:underline">
          <IconFileSpreadsheet size={17} /> Bulk import from CSV
        </Link>
      </div>
      <form onSubmit={onSubmit} className="space-y-6">
        {topError && (
          <p className="rounded-lg border border-dues/30 bg-dues/10 px-4 py-3 text-sm text-dues">
            {topError}
          </p>
        )}

        {/* Identity */}
        <Section title="Item details" hint="Item No is assigned automatically on save (SHOP-0001…).">
          <Field
            label="Item name" placeholder="e.g. Wedding Card – Royal Red"
            value={form.name} onChange={set('name')} error={errors.name} autoFocus
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Select label="Company / Supplier" value={form.supplier_id}
                      onChange={set('supplier_id')} error={errors.supplier_id}>
                <option value="">Select supplier…</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </Select>
              <button type="button" onClick={() => setShowSupplier(true)}
                      className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-peacock hover:underline">
                <IconPlus size={14} /> New supplier
              </button>
            </div>
            <Select label="Category" value={form.category_id}
                    onChange={set('category_id')} error={errors.category_id}>
              <option value="">Select category…</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </Select>
          </div>
          <Field label="Location / Rack No" placeholder="e.g. R1-A (display only)"
                 value={form.location} onChange={set('location')} />
          <Textarea label="Description (optional)" rows={3} value={form.description}
                    onChange={set('description')}
                    placeholder="Shown on the shopfront item page — material, size, occasion…" />
          <TagsInput label="Tags (optional)" value={form.tags}
                     onChange={(tags) => setForm((f) => ({ ...f, tags }))}
                     hint="Used for search & filtering, e.g. wedding, premium, handmade." />
        </Section>

        {/* Stock & pricing */}
        <Section title="Opening stock & rates" hint="Purchase Rate is your cost — it is never shown to buyers.">
          {/* Make to Order — no stock is held; you source/make it after a booking. */}
          <div className="flex items-center justify-between rounded-lg bg-paper-2 px-4 py-3">
            <div>
              <p className="text-sm font-medium">Make to Order (no stock limit)</p>
              <p className="text-xs text-muted">
                Always shown on the shopfront. Buyers can order any quantity — you set the cost when you approve.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setForm((f) => ({ ...f, made_to_order: !f.made_to_order }))}
              className={`relative h-6 w-11 shrink-0 rounded-full transition ${form.made_to_order ? 'bg-peacock' : 'bg-line'}`}
              aria-pressed={form.made_to_order}
            >
              <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-card transition ${form.made_to_order ? 'left-[1.375rem]' : 'left-0.5'}`} />
            </button>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            {!form.made_to_order && (
              <>
                <Field label="Quantity coming in" type="number" min="0" inputMode="decimal"
                       value={form.quantity} onChange={set('quantity')} error={errors.quantity} />
                <Field label="Low stock threshold" type="number" min="0" inputMode="decimal"
                       value={form.low_stock_threshold} onChange={set('low_stock_threshold')}
                       hint="Flag as Low below this" />
              </>
            )}
            <Field label="Min order qty (MOQ)" type="number" min="1" inputMode="decimal"
                   value={form.moq} onChange={set('moq')} error={errors.moq}
                   hint="Least a customer can order" />
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            {!form.made_to_order && (
              <Field label="Purchase Rate" prefix="₹" type="number" min="0" step="0.01" inputMode="decimal"
                     value={form.purchase_rate} onChange={set('purchase_rate')} error={errors.purchase_rate} />
            )}
            <Field label="Dealer Rate" prefix="₹" type="number" min="0" step="0.01" inputMode="decimal"
                   value={form.dealer_rate} onChange={set('dealer_rate')} error={errors.dealer_rate} />
            <Field label="Rate (retail)" prefix="₹" type="number" min="0" step="0.01" inputMode="decimal"
                   value={form.rate} onChange={set('rate')} error={errors.rate} />
          </div>
          {form.made_to_order ? (
            <p className="rounded-lg bg-peacock/5 px-4 py-2.5 text-sm text-muted">
              No opening stock is recorded. You’ll enter the real cost on each order when you approve it.
            </p>
          ) : liveCost != null && (
            <p className="rounded-lg bg-paper-2 px-4 py-2.5 text-sm">
              Total purchase cost:{' '}
              <span className="fig font-bold text-dues">{money(liveCost)}</span>
              <span className="text-muted"> — added to this supplier's balance.</span>
            </p>
          )}
        </Section>

        {/* Photo & barcode */}
        <Section title="Photo & barcode" hint="Both optional. A photo helps staff and the shopfront.">
          <div className="flex flex-wrap items-start gap-4">
            <div className="h-28 w-28 shrink-0 overflow-hidden rounded-lg border border-line bg-paper-2">
              {photoPreview || scannedPhotoUrl ? (
                <img src={photoPreview || scannedPhotoUrl} alt="preview" className="h-full w-full object-cover" />
              ) : (
                <div className="grid h-full w-full place-items-center text-muted">
                  <IconCamera size={26} />
                </div>
              )}
            </div>
            <div className="space-y-2">
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-line bg-card px-4 py-2.5 text-sm font-semibold hover:bg-paper-2">
                <IconCamera size={18} /> {photoPreview || scannedPhotoUrl ? 'Change photo' : 'Add photo'}
                <input type="file" accept="image/*" capture="environment" className="hidden" onChange={onPhoto} />
              </label>
              {(photoPreview || scannedPhotoUrl) && (
                <button type="button" onClick={clearPhoto}
                        className="ml-2 inline-flex items-center gap-1 text-xs text-dues hover:underline">
                  <IconX size={14} /> Remove
                </button>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[12rem] flex-1">
              <Field label="Barcode / QR code" placeholder="Scan or type a code"
                     value={form.barcode} onChange={set('barcode')} />
            </div>
            <Button onClick={() => setShowScanner(true)} disabled={scanBusy}>
              {scanBusy ? <><Spinner /> Looking up…</> : <><IconScan size={18} /> Scan</>}
            </Button>
            <Button variant="ghost" onClick={generateBarcode}>
              <IconBarcode size={18} /> Generate
            </Button>
          </div>

          {scanInfo?.tone === 'found' && (
            <div className="rounded-lg border border-peacock/30 bg-peacock/5 px-4 py-3 text-sm">
              <p className="font-semibold text-ink">This product is already in your shop.</p>
              <p className="mt-0.5 text-muted">
                <span className="fig">{scanInfo.item.item_no}</span> — {scanInfo.item.name} ·{' '}
                in stock <span className="fig font-semibold text-ink">{qty(scanInfo.item.quantity)}</span>
              </p>
              <p className="mt-1 text-muted">Add new stock to it instead of creating a duplicate:</p>
              <button
                type="button"
                onClick={() => navigate(`/owner/purchase?item=${scanInfo.item.id}`)}
                className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-peacock px-3 py-2 text-sm font-semibold text-white hover:bg-peacock-700"
              >
                <IconCircleArrowRight size={17} /> Restock this item
              </button>
            </div>
          )}
          {scanInfo?.tone === 'api' && (
            <p className="rounded-lg border border-profit/30 bg-profit/5 px-4 py-3 text-sm">
              Found online: <span className="font-semibold text-ink">{scanInfo.name}</span>. Name and photo
              were filled in — check them, then set your rates and supplier below.
            </p>
          )}
          {scanInfo?.tone === 'none' && (
            <p className="rounded-lg bg-paper-2 px-4 py-3 text-sm text-muted">
              No matching product found. The code was saved — fill in the rest of the details below.
            </p>
          )}

          <ImagesInput label="More photos (optional)" value={form.images}
                       onChange={(images) => setForm((f) => ({ ...f, images }))}
                       hint="Extra images shown in a gallery on the item page. The photo above stays the cover." />
        </Section>

        <Textarea label="Notes (optional)" rows={2} value={form.notes}
                  onChange={set('notes')} placeholder="Bill number, batch, anything to remember" />

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={busy} className="px-6">
            {busy ? <><Spinner /> Saving…</> : 'Save & Stock In'}
          </Button>
          <Link to="/owner/inventory" className="text-sm font-medium text-muted hover:text-ink">
            Cancel
          </Link>
        </div>
      </form>

      {showScanner && (
        <BarcodeScanner onClose={() => setShowScanner(false)} onDetected={handleDetected} />
      )}

      {showSupplier && (
        <SupplierModal
          shopId={shopId}
          onClose={() => setShowSupplier(false)}
          onCreated={async (id) => {
            await refreshSuppliers()
            setForm((f) => ({ ...f, supplier_id: id }))
            setErrors((er) => ({ ...er, supplier_id: undefined }))
            setShowSupplier(false)
          }}
        />
      )}
    </div>
  )
}

function Section({ title, hint, children }) {
  return (
    <section className="rounded-lg border border-line bg-card p-5 sm:p-6">
      <h3 className="font-[var(--font-display)] text-lg font-bold">{title}</h3>
      {hint && <p className="mb-4 mt-0.5 text-sm text-muted">{hint}</p>}
      <div className="space-y-4">{children}</div>
    </section>
  )
}

function Success({ done, onAnother }) {
  return (
    <div className="mx-auto max-w-md rounded-lg border border-line bg-card p-8 text-center">
      <div className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-full bg-profit/10 text-profit">
        <IconCircleCheck size={34} />
      </div>
      <h2 className="font-[var(--font-display)] text-2xl font-bold">
        {done.made_to_order ? 'Item listed' : 'Stock added'}
      </h2>
      <p className="mt-1 text-muted">
        <span className="fig font-semibold text-ink">{done.item_no}</span> — {done.name}
      </p>
      {done.made_to_order ? (
        <p className="mt-5 rounded-lg bg-peacock/5 px-4 py-3 text-left text-sm text-muted">
          This is a <span className="font-medium text-ink">Make to Order</span> item. It’s live on the shopfront now —
          buyers can order any quantity, and you’ll set the cost when you approve each order.
        </p>
      ) : (
        <div className="mt-5 grid grid-cols-2 gap-3 text-left">
          <Box label="Stocked in" value={`${done.quantity}`} />
          <Box label="Added to supplier due" value={money(done.total_cost)} tone="dues" />
        </div>
      )}
      <div className="mt-6 flex justify-center gap-3">
        <Button onClick={onAnother}>
          <IconPlus size={18} /> Add another
        </Button>
        <Link to="/owner/inventory"
              className="inline-flex items-center rounded-lg border border-line bg-card px-4 py-2.5 text-sm font-semibold hover:bg-paper-2">
          View Inventory
        </Link>
      </div>
    </div>
  )
}

function Box({ label, value, tone }) {
  return (
    <div className="rounded-lg bg-paper-2 px-4 py-3">
      <p className="text-xs text-muted">{label}</p>
      <p className={`fig text-lg font-bold ${tone === 'dues' ? 'text-dues' : 'text-ink'}`}>{value}</p>
    </div>
  )
}

// Restock an existing item (SPEC §6.9 — reached from Stock Inquiry's low list).
// Item identity is fixed; the owner only enters how many came in and at what
// cost. A purchases row does the rest via trigger. We do NOT change the item's
// catalogue rates here — the batch cost lives on the purchase row.
function RestockEntry({ itemId }) {
  const { profile } = useAuth()
  const { shopId } = useShop()
  const [item, setItem] = useState(null)
  const [loadErr, setLoadErr] = useState('')
  const [form, setForm] = useState({ quantity: '', purchase_rate: '', notes: '' })
  const [errors, setErrors] = useState({})
  const [busy, setBusy] = useState(false)
  const [topError, setTopError] = useState('')
  const [done, setDone] = useState(null)

  const set = (k) => (e) => {
    setForm((f) => ({ ...f, [k]: e.target.value }))
    setErrors((er) => ({ ...er, [k]: undefined }))
  }

  useEffect(() => {
    supabase
      .from('items')
      .select(
        'id, item_no, name, quantity, purchase_rate, low_stock_threshold, ' +
          'supplier_id, supplier:suppliers(name), category:categories(name)',
      )
      .eq('id', itemId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) setLoadErr(error.message)
        else if (!data) setLoadErr('That item could not be found.')
        else {
          setItem(data)
          setForm((f) => ({ ...f, purchase_rate: String(data.purchase_rate) }))
        }
      })
  }, [itemId])

  async function onSubmit(e) {
    e.preventDefault()
    setTopError('')
    const er = {}
    if (!form.quantity || Number(form.quantity) <= 0) er.quantity = 'Enter how many came in.'
    if (form.purchase_rate === '' || Number(form.purchase_rate) < 0) er.purchase_rate = 'Enter the cost rate.'
    setErrors(er)
    if (Object.keys(er).length) return

    setBusy(true)
    try {
      const quantity = round2(form.quantity)
      const purchase_rate = round2(form.purchase_rate)
      const total_cost = round2(quantity * purchase_rate)
      const { error } = await supabase.from('purchases').insert({
        shop_id: shopId,
        item_id: item.id,
        supplier_id: item.supplier_id,
        quantity,
        purchase_rate,
        total_cost,
        entered_by: profile.id,
        notes: form.notes.trim() || null,
      })
      if (error) throw new Error(error.message)
      setDone({ item_no: item.item_no, name: item.name, quantity, total_cost })
    } catch (err) {
      setTopError(err.message || 'Could not save. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  if (loadErr) {
    return (
      <div className="mx-auto max-w-md rounded-lg border border-line bg-card p-8 text-center">
        <p className="text-dues">{loadErr}</p>
        <Link to="/owner/stock" className="mt-4 inline-block font-medium text-peacock hover:underline">
          ← Back to Stock Inquiry
        </Link>
      </div>
    )
  }
  if (!item) return <div className="grid place-items-center py-16 text-muted"><Spinner /></div>

  if (done) {
    return (
      <div className="mx-auto max-w-md rounded-lg border border-line bg-card p-8 text-center">
        <div className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-full bg-profit/10 text-profit">
          <IconCircleCheck size={34} />
        </div>
        <h2 className="font-[var(--font-display)] text-2xl font-bold">Stock added</h2>
        <p className="mt-1 text-muted">
          <span className="fig font-semibold text-ink">{done.item_no}</span> — {done.name}
        </p>
        <div className="mt-5 grid grid-cols-2 gap-3 text-left">
          <Box label="Stocked in" value={`${done.quantity}`} />
          <Box label="Added to supplier due" value={money(done.total_cost)} tone="dues" />
        </div>
        <div className="mt-6 flex justify-center gap-3">
          <Link to="/owner/stock"
                className="inline-flex items-center rounded-lg bg-peacock px-4 py-2.5 text-sm font-semibold text-white hover:bg-peacock-700">
            Back to Stock Inquiry
          </Link>
          <Link to="/owner/inventory"
                className="inline-flex items-center rounded-lg border border-line bg-card px-4 py-2.5 text-sm font-semibold hover:bg-paper-2">
            View Inventory
          </Link>
        </div>
      </div>
    )
  }

  const liveCost =
    form.quantity && form.purchase_rate
      ? round2(Number(form.quantity) * Number(form.purchase_rate))
      : null

  return (
    <div className="mx-auto max-w-2xl">
      <Link to="/owner/stock" className="mb-4 inline-block text-sm font-medium text-muted hover:text-ink">
        ← Stock Inquiry
      </Link>
      <form onSubmit={onSubmit} className="space-y-6">
        {topError && (
          <p className="rounded-lg border border-dues/30 bg-dues/10 px-4 py-3 text-sm text-dues">{topError}</p>
        )}

        {/* Fixed identity of the item being restocked */}
        <section className="rounded-lg border border-line bg-card p-5 sm:p-6">
          <p className="text-sm text-muted">Restocking</p>
          <h3 className="font-[var(--font-display)] text-xl font-bold">{item.name}</h3>
          <p className="fig mt-0.5 text-xs text-muted">
            {item.item_no} · {item.category?.name || '—'} · {item.supplier?.name || '—'}
          </p>
          <div className="mt-3 flex items-center gap-2 text-sm">
            <span className="text-muted">In stock now:</span>
            <span className="fig font-semibold">{qty(item.quantity)}</span>
            <StockBadge quantity={item.quantity} threshold={item.low_stock_threshold} />
          </div>
        </section>

        <Section title="Stock coming in" hint="Purchase Rate defaults to the current cost — change it if this batch cost differs.">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Quantity coming in" type="number" min="0" inputMode="decimal"
                   value={form.quantity} onChange={set('quantity')} error={errors.quantity} autoFocus />
            <Field label="Purchase Rate" prefix="₹" type="number" min="0" step="0.01" inputMode="decimal"
                   value={form.purchase_rate} onChange={set('purchase_rate')} error={errors.purchase_rate} />
          </div>
          {liveCost != null && (
            <p className="rounded-lg bg-paper-2 px-4 py-2.5 text-sm">
              Total purchase cost:{' '}
              <span className="fig font-bold text-dues">{money(liveCost)}</span>
              <span className="text-muted"> — added to {item.supplier?.name || 'the supplier'}'s balance.</span>
            </p>
          )}
        </Section>

        <Textarea label="Notes (optional)" rows={2} value={form.notes}
                  onChange={set('notes')} placeholder="Bill number, batch, anything to remember" />

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={busy} className="px-6">
            {busy ? <><Spinner /> Saving…</> : 'Save & Stock In'}
          </Button>
          <Link to="/owner/stock" className="text-sm font-medium text-muted hover:text-ink">Cancel</Link>
        </div>
      </form>
    </div>
  )
}

function SupplierModal({ shopId, onClose, onCreated }) {
  const [f, setF] = useState({ name: '', contact_person: '', phone: '', address: '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }))

  async function save(e) {
    e.preventDefault()
    if (!f.name.trim()) { setErr('Supplier name is required.'); return }
    setBusy(true); setErr('')
    const { data, error } = await supabase
      .from('suppliers')
      .insert({
        shop_id: shopId,
        name: f.name.trim(),
        contact_person: f.contact_person.trim() || null,
        phone: f.phone.trim() || null,
        address: f.address.trim() || null,
      })
      .select('id')
      .single()
    setBusy(false)
    if (error) { setErr(error.message); return }
    onCreated(data.id)
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/40 p-4" onClick={onClose}>
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={save}
        className="w-full max-w-md space-y-4 rounded-lg border border-line bg-card p-6"
      >
        <div className="flex items-center justify-between">
          <h3 className="font-[var(--font-display)] text-xl font-bold">New supplier</h3>
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-muted hover:bg-paper-2">
            <IconX size={20} />
          </button>
        </div>
        {err && <p className="rounded-lg bg-dues/10 px-3 py-2 text-sm text-dues">{err}</p>}
        <Field label="Supplier / Company name" value={f.name} onChange={set('name')} autoFocus />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Contact person" value={f.contact_person} onChange={set('contact_person')} />
          <Field label="Phone" type="tel" value={f.phone} onChange={set('phone')} />
        </div>
        <Field label="Address" value={f.address} onChange={set('address')} />
        <div className="flex justify-end gap-3 pt-1">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? <><Spinner /> Saving…</> : 'Add supplier'}</Button>
        </div>
      </form>
    </div>
  )
}
