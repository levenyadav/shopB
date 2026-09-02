import { useEffect, useState } from 'react'
import {
  IconCamera, IconPlus, IconBarcode, IconX, IconScan, IconTrash, IconPencil,
  IconCircleArrowRight, IconSparkles, IconChevronDown, IconChevronUp,
} from '@tabler/icons-react'
import { supabase } from '../../lib/supabase'
import { useShop } from '../../context/ShopContext'
import { money, qty } from '../../lib/format'
import {
  round2, isDuplicateCompanyNo, itemGstRate, combineGstRate,
  suggestPurchaseGst,
} from '../../lib/helpers'
import { Button, Field, Select, Textarea, Spinner, StockBadge, TagsInput, ImagesInput, Badge } from '../ui'
import BarcodeScanner from '../BarcodeScanner'

// =============================================================================
// The shared parts of building a supplier bill (SPEC §6.1).
//
// Two screens build the SAME bill and must therefore offer the same options and
// behave identically:
//
//   • Purchase Entry          — entering a bill for the first time
//   • Purchase Bill Detail    — correcting one that was already entered (039)
//
// Everything both screens need lives here, so the two can never drift apart:
// the line table, the line editor in both its modes (restock an existing item /
// create a new product), the postage + auto-GST block, and the small layout
// pieces they share. Neither screen writes stock or balances itself — that is
// always a trigger's job (Golden Rule #10).
// =============================================================================

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

// A blank "new product" line. Mirrors the items table (SPEC §7.5).
export const BLANK_NEW = {
  mode: 'new',
  name: '', company_no: '', category_id: '', location: '', warehouse_id: '',
  quantity: '', purchase_rate: '', dealer_rate: '', rate: '',
  // GST is entered as the CGST/SGST pair the owner reads off the bill, and
  // stored as their sum in items.gst_rate (migration 034). Both blank = use the
  // shop's default rate.
  cgst_rate: '', sgst_rate: '', hsn_sac: '',
  low_stock_threshold: '10', moq: '1', barcode: '', notes: '',
  description: '', tags: [], images: [],
  made_to_order: false, is_active: true,
  photoFile: null, photoPreview: '', scannedPhotoUrl: '',
}

export const today = () => new Date().toISOString().slice(0, 10)

// A Make-to-Order product is listed, never stocked — so it never becomes a
// purchases row and contributes nothing to the bill total.
export function isListingOnly(line) {
  return line.mode === 'new' && line.made_to_order
}

export function lineName(line) {
  return line.mode === 'new' ? line.name : line.item?.name || ''
}

export function lineCost(line) {
  if (isListingOnly(line)) return 0
  return round2(Number(line.quantity || 0) * Number(line.purchase_rate || 0))
}

export function LinesTable({ lines, onEdit, onRemove }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="w-full text-left text-sm">
        <thead className="bg-paper-2 text-xs uppercase tracking-wider text-muted">
          <tr>
            <Th>Product</Th>
            <Th right>Qty</Th>
            <Th right>Cost rate</Th>
            <Th right>Line total</Th>
            <Th />
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {lines.map((l, i) => (
            <tr key={i}>
              <Td>
                <span className="font-medium">{lineName(l)}</span>
                <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
                  {l.mode === 'new'
                    ? <Badge tone="saffron">new product</Badge>
                    : <span className="fig text-xs text-muted">{l.item?.item_no}</span>}
                  {isListingOnly(l) && <Badge>listing only — no stock</Badge>}
                </span>
              </Td>
              <Td right className="fig">{isListingOnly(l) ? '—' : qty(l.quantity)}</Td>
              <Td right className="fig">{isListingOnly(l) ? '—' : money(l.purchase_rate)}</Td>
              <Td right className="fig font-semibold">{isListingOnly(l) ? '—' : money(lineCost(l))}</Td>
              <Td right>
                <span className="inline-flex gap-1">
                  <button type="button" onClick={() => onEdit(i)} aria-label={`Edit ${lineName(l)}`}
                          className="rounded-md p-1.5 text-muted hover:bg-paper-2 hover:text-ink">
                    <IconPencil size={16} />
                  </button>
                  <button type="button" onClick={() => onRemove(i)} aria-label={`Remove ${lineName(l)}`}
                          className="rounded-md p-1.5 text-muted hover:bg-dues/10 hover:text-dues">
                    <IconTrash size={16} />
                  </button>
                </span>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Th({ children, right }) {
  return <th className={`px-3 py-2 font-semibold ${right ? 'text-right' : ''}`}>{children}</th>
}
function Td({ children, right, className = '' }) {
  return <td className={`px-3 py-2 align-top ${right ? 'text-right' : ''} ${className}`}>{children}</td>
}

// =============================================================================
// Line editor — one product on the bill, in either mode.
// Kept in a dialog so the bill screen itself stays a short, scannable list
// (SPEC §3: simple on top, max two screens).
// =============================================================================
export function LineEditor({
  initial, shopId, supplierId, onClose, onSave,
  // Correcting a bill has no use for a listing-only line: a Make-to-Order
  // product buys nothing, so adding one to a bill would change nothing about it.
  allowMadeToOrder = true,
  submitLabel,
}) {
  const [line, setLine] = useState(initial)
  const [errors, setErrors] = useState({})
  const isNew = line.mode === 'new'

  const set = (k) => (e) => {
    setLine((l) => ({ ...l, [k]: e.target.value }))
    setErrors((er) => ({ ...er, [k]: undefined }))
  }
  const setVal = (k, v) => {
    setLine((l) => ({ ...l, [k]: v }))
    setErrors((er) => ({ ...er, [k]: undefined }))
  }

  function validate() {
    const e = {}
    if (isNew) {
      if (!line.name.trim()) e.name = 'Product name is required.'
      if (!line.category_id) e.category_id = 'Choose a category.'
      if (line.dealer_rate === '' || Number(line.dealer_rate) < 0) e.dealer_rate = 'Enter the dealer rate.'
      if (line.rate === '' || Number(line.rate) < 0) e.rate = 'Enter the retail rate.'
      if (line.moq !== '' && Number(line.moq) < 1) e.moq = 'MOQ must be at least 1.'
    } else if (!line.item) {
      e.item = 'Pick the product this line is for.'
    }
    // Make-to-Order products carry no opening stock, so no quantity is needed —
    // but the cost rate still is: it prices profit when an order is approved.
    if (!isListingOnly(line)) {
      if (!line.quantity || Number(line.quantity) <= 0) e.quantity = 'Enter how many came in.'
    }
    if (line.purchase_rate === '' || Number(line.purchase_rate) < 0) e.purchase_rate = 'Enter the cost rate.'
    setErrors(e)
    return Object.keys(e).length === 0
  }

  function submit(e) {
    e.preventDefault()
    if (!validate()) return
    onSave(line)
  }

  // The owner started typing a new product, then found it already exists (by
  // name or barcode). Flip this line to a restock of that item, keeping the
  // quantity and notes they had already entered.
  function useExistingItem(item) {
    setLine((l) => ({
      mode: 'existing',
      item,
      quantity: l.quantity,
      purchase_rate: String(item.purchase_rate ?? l.purchase_rate ?? ''),
      notes: l.notes || '',
    }))
    setErrors({})
  }

  const cost = lineCost(line)

  return (
    <Dialog
      title={isNew ? 'New product on this bill' : 'Add existing item'}
      hint={isNew ? 'Item No is assigned automatically on save (SHOP-0001…).' : undefined}
      onClose={onClose}
    >
      <form onSubmit={submit} className="space-y-5">
        {isNew
          ? <NewProductFields line={line} set={set} setVal={setVal} errors={errors}
                              shopId={shopId} onUseExisting={useExistingItem}
                              allowMadeToOrder={allowMadeToOrder} />
          : <ExistingItemFields line={line} setVal={setVal} errors={errors}
                                shopId={shopId} supplierId={supplierId} />}

        {/* Quantity + cost — the two numbers every bill line needs */}
        <div className="grid gap-4 sm:grid-cols-2">
          {!isListingOnly(line) && (
            <Field label="Quantity coming in" type="number" min="0" inputMode="decimal"
                   value={line.quantity} onChange={set('quantity')} error={errors.quantity} />
          )}
          <Field label="Purchase Rate" prefix="₹" type="number" min="0" step="0.01" inputMode="decimal"
                 value={line.purchase_rate} onChange={set('purchase_rate')} error={errors.purchase_rate}
                 hint={isListingOnly(line) ? 'Cost per piece — used when you approve orders' : 'Your cost — never shown to buyers'} />
        </div>

        {isListingOnly(line) ? (
          <p className="rounded-lg bg-peacock/5 px-4 py-2.5 text-sm text-muted">
            Make to Order — no stock is bought on this bill. The cost above is used to
            work out profit when you approve each order.
          </p>
        ) : cost > 0 && (
          <p className="rounded-lg bg-paper-2 px-4 py-2.5 text-sm">
            Line total: <span className="fig font-bold text-dues">{money(cost)}</span>
          </p>
        )}

        <Textarea label="Notes (optional)" rows={2} value={line.notes || ''}
                  onChange={set('notes')}
                  placeholder="Batch, damage, anything to remember about this product" />

        <div className="flex justify-end gap-3 pt-1">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit">
            <IconPlus size={18} /> {submitLabel || (initial.item || initial.name ? 'Save line' : 'Add to bill')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

// ---- Existing item mode: search the catalogue, then top it up ----
function ExistingItemFields({ line, setVal, errors, shopId, supplierId }) {
  const { warehouses } = useShop()
  const [search, setSearch] = useState('')
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [onlyThisSupplier, setOnlyThisSupplier] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    // Make-to-Order items hold no stock, so they can never be restocked.
    let q = supabase
      .from('items')
      .select('id, item_no, name, company_no, quantity, purchase_rate, low_stock_threshold, supplier_id, discontinued, gst_rate, warehouse_id')
      .eq('shop_id', shopId)
      .eq('made_to_order', false)
      .order('name')
      .limit(50)
    if (onlyThisSupplier && supplierId) q = q.eq('supplier_id', supplierId)
    const term = search.trim()
    if (term) q = q.or(`name.ilike.%${term}%,item_no.ilike.%${term}%,company_no.ilike.%${term}%`)
    q.then(({ data }) => {
      if (!cancelled) { setItems(data || []); setLoading(false) }
    })
    return () => { cancelled = true }
  }, [search, shopId, supplierId, onlyThisSupplier])

  if (line.item) {
    return (
      <div className="rounded-lg border border-line bg-paper-2 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="font-semibold">{line.item.name}</p>
            <p className="fig mt-0.5 text-xs text-muted">{line.item.item_no}</p>
            <p className="mt-1.5 flex items-center gap-2 text-sm">
              <span className="text-muted">In stock now:</span>
              <span className="fig font-semibold">{qty(line.item.quantity)}</span>
              <StockBadge quantity={line.item.quantity} threshold={line.item.low_stock_threshold} />
            </p>
          </div>
          <button type="button" onClick={() => setVal('item', null)}
                  className="text-sm font-medium text-peacock hover:underline">
            Change
          </button>
        </div>
        {warehouses.length > 1 && (
          <Select label="Warehouse" value={line.warehouse_id ?? line.item.warehouse_id ?? ''}
                  onChange={(e) => setVal('warehouse_id', e.target.value)}
                  hint="Where this restock lands — defaults to this product's usual warehouse">
            <option value="">{warehouses.find((w) => w.name === 'Main Warehouse') ? 'Main Warehouse (default)' : 'Select warehouse…'}</option>
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </Select>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <Field label="Find the product" placeholder="Search by name, item no. or company no."
             value={search} onChange={(e) => setSearch(e.target.value)} error={errors.item} autoFocus />

      {supplierId && (
        <label className="flex items-center gap-2 text-sm text-muted">
          <input type="checkbox" checked={onlyThisSupplier}
                 onChange={(e) => setOnlyThisSupplier(e.target.checked)}
                 className="h-4 w-4 rounded border-line" />
          Only show products from this supplier
        </label>
      )}

      <div className="max-h-64 overflow-y-auto rounded-lg border border-line">
        {loading ? (
          <div className="grid place-items-center py-8 text-muted"><Spinner /></div>
        ) : items.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted">
            No matching products. Uncheck the supplier filter, or add it as a new product instead.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {items.map((it) => (
              <li key={it.id}>
                <button
                  type="button"
                  onClick={() => {
                    setVal('item', it)
                    // Default the cost to what this item last cost; the owner
                    // overrides it when this batch came in at a different rate.
                    setVal('purchase_rate', String(it.purchase_rate))
                  }}
                  className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-paper-2"
                >
                  <span>
                    <span className="font-medium">{it.name}</span>
                    {it.discontinued && <Badge tone="dues">discontinued</Badge>}
                    <span className="fig block text-xs text-muted">
                      {it.item_no}{it.company_no ? ` · ${it.company_no}` : ''}
                    </span>
                  </span>
                  <span className="fig shrink-0 text-sm text-muted">{qty(it.quantity)} in stock</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

// ---- New product mode: the full catalogue form. Everything the old single-item
// Purchase Entry asked for stays on screen; only the shopfront copy (description,
// tags, gallery) folds away, since it can be filled in later from Inventory. ----
function NewProductFields({ line, set, setVal, errors, shopId, onUseExisting, allowMadeToOrder = true }) {
  const { categories, shop, warehouses } = useShop()
  const shopGstRate = Number(shop?.gst_rate || 0)
  // null = neither half filled in, so this product follows the shop default.
  const combinedGst = combineGstRate(line.cgst_rate, line.sgst_rate)
  const [more, setMore] = useState(false)
  const [showScanner, setShowScanner] = useState(false)
  const [scanBusy, setScanBusy] = useState(false)
  const [scanInfo, setScanInfo] = useState(null)
  const [nameInfo, setNameInfo] = useState(null)

  // Guard against duplicate items: when the name field loses focus, look for an
  // item that already carries this exact name in the shop (case-insensitive).
  // Nudge the owner to add it as an existing line rather than a second row.
  async function checkName() {
    const name = line.name.trim()
    if (!name) { setNameInfo(null); return }
    const { data } = await supabase
      .from('items')
      .select('id, item_no, name, quantity, purchase_rate, low_stock_threshold')
      .eq('shop_id', shopId)
      .ilike('name', name)
      .limit(1)
      .maybeSingle()
    setNameInfo(data || null)
  }

  function generateBarcode() {
    setVal('barcode', 'SC' + Date.now().toString(36).toUpperCase())
  }

  // A code was scanned. Resolve it: our catalogue → already stocked; else a
  // public product DB → prefill name + photo; else just keep the code.
  async function handleDetected(code) {
    setShowScanner(false)
    setScanBusy(true)
    setScanInfo(null)
    setVal('barcode', code)
    try {
      const { data: existing } = await supabase
        .from('items')
        .select('id, item_no, name, quantity, purchase_rate, low_stock_threshold')
        .eq('shop_id', shopId)
        .eq('barcode', code)
        .maybeSingle()
      if (existing) { setScanInfo({ tone: 'found', item: existing }); return }

      const found = await lookupPublicProduct(code)
      if (found) {
        if (!line.name.trim()) setVal('name', found.name)
        if (found.image) {
          setVal('photoFile', null)
          setVal('photoPreview', '')
          setVal('scannedPhotoUrl', found.image)
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

  function onPhoto(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setVal('photoFile', file)
    setVal('photoPreview', URL.createObjectURL(file))
    setVal('scannedPhotoUrl', '')
  }

  function clearPhoto() {
    if (line.photoPreview) URL.revokeObjectURL(line.photoPreview)
    setVal('photoFile', null)
    setVal('photoPreview', '')
    setVal('scannedPhotoUrl', '')
  }

  const preview = line.photoPreview || line.scannedPhotoUrl

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Product name" placeholder="e.g. Wedding Card – Royal Red"
               value={line.name} onChange={set('name')} onBlur={checkName} error={errors.name} autoFocus />
        <Field label="Company No." placeholder="e.g. 1420 (design / article no.)"
               value={line.company_no} onChange={set('company_no')} error={errors.company_no}
               hint="The company's own design number — used to re-order" />
      </div>

      {nameInfo && (
        <div className="rounded-lg border border-peacock/30 bg-peacock/5 px-4 py-3 text-sm">
          <p className="font-semibold text-ink">A product with this name is already in your shop.</p>
          <p className="mt-0.5 text-muted">
            <span className="fig">{nameInfo.item_no}</span> — {nameInfo.name} ·{' '}
            in stock <span className="fig font-semibold text-ink">{qty(nameInfo.quantity)}</span>
          </p>
          <p className="mt-1 text-muted">Add new stock to it instead of creating a duplicate:</p>
          <button
            type="button"
            onClick={() => onUseExisting(nameInfo)}
            className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-peacock px-3 py-2 text-sm font-semibold text-white hover:bg-peacock-700"
          >
            <IconCircleArrowRight size={17} /> Use this item on the bill
          </button>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Select label="Category" value={line.category_id} onChange={set('category_id')} error={errors.category_id}>
          <option value="">Select category…</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <Field label="Location / Rack No" placeholder="e.g. R1-A (display only)"
               value={line.location} onChange={set('location')} />
      </div>

      {warehouses.length > 1 && (
        <Select label="Warehouse" value={line.warehouse_id} onChange={set('warehouse_id')}
                hint="Where this product stocks in — set once here, not on every bill">
          <option value="">{warehouses.find((w) => w.name === 'Main Warehouse') ? 'Main Warehouse (default)' : 'Select warehouse…'}</option>
          {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </Select>
      )}

      {/* Make to Order — listed on the shopfront but never stocked. */}
      {allowMadeToOrder && (
        <Toggle
          label="Make to Order (no stock limit)"
          hint="Always shown on the shopfront. Buyers can order any quantity — nothing is stocked in on this bill."
          on={line.made_to_order}
          onChange={() => setVal('made_to_order', !line.made_to_order)}
        />
      )}
      <Toggle
        label="Active on storefront"
        hint="Show this product on your public shopfront. Turn off to keep it in your catalogue but hidden from buyers."
        on={line.is_active}
        onChange={() => setVal('is_active', !line.is_active)}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Dealer Rate" prefix="₹" type="number" min="0" step="0.01" inputMode="decimal"
               value={line.dealer_rate} onChange={set('dealer_rate')} error={errors.dealer_rate} />
        <Field label="Rate (retail)" prefix="₹" type="number" min="0" step="0.01" inputMode="decimal"
               value={line.rate} onChange={set('rate')} error={errors.rate} />
      </div>

      {/* Tax details for THIS product. Settings holds one default GST rate, but
          cards, boxes and gift items don't all sit in the same slab — set it here
          and this product's invoices are taxed at its own rate. Entered as the
          CGST/SGST pair the bill prints; the two are summed into the one slab
          that is stored (migration 034). The HSN/SAC code travels with the slab
          and prints on the tax invoice beside it. */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="CGST %" type="number" min="0" max="50" step="0.01" inputMode="decimal"
               placeholder={String(round2(shopGstRate / 2))}
               value={line.cgst_rate} onChange={set('cgst_rate')} />
        <Field label="SGST %" type="number" min="0" max="50" step="0.01" inputMode="decimal"
               placeholder={String(round2(shopGstRate - round2(shopGstRate / 2)))}
               value={line.sgst_rate} onChange={set('sgst_rate')} />
        <Field label="HSN / SAC code" placeholder="e.g. 4817"
               value={line.hsn_sac} onChange={set('hsn_sac')}
               hint="Optional. Printed on the tax invoice." />
      </div>
      <p className="-mt-2 text-xs text-muted">
        {combinedGst === null
          ? `Leave both blank to use the shop default — ${shopGstRate}% (${round2(shopGstRate / 2)}% + ${round2(shopGstRate - round2(shopGstRate / 2))}%).`
          : <>This product is taxed at <span className="fig font-semibold text-ink">{combinedGst}%</span> GST
             {combinedGst === 0 && ' — exempt / nil-rated'}.</>}
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Min order qty (MOQ)" type="number" min="1" inputMode="decimal"
               value={line.moq} onChange={set('moq')} error={errors.moq}
               hint="Least a customer can order" />
        {!line.made_to_order && (
          <Field label="Low stock threshold" type="number" min="0" inputMode="decimal"
                 value={line.low_stock_threshold} onChange={set('low_stock_threshold')}
                 hint="Flag as Low below this" />
        )}
      </div>

      {/* Photo */}
      <div className="flex flex-wrap items-start gap-4">
        <div className="h-24 w-24 shrink-0 overflow-hidden rounded-lg border border-line bg-paper-2">
          {preview
            ? <img src={preview} alt="preview" className="h-full w-full object-cover" />
            : <div className="grid h-full w-full place-items-center text-muted"><IconCamera size={24} /></div>}
        </div>
        <div className="space-y-2">
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-line bg-card px-4 py-2.5 text-sm font-semibold hover:bg-paper-2">
            <IconCamera size={18} /> {preview ? 'Change photo' : 'Add photo'}
            <input type="file" accept="image/*" capture="environment" className="hidden" onChange={onPhoto} />
          </label>
          {preview && (
            <button type="button" onClick={clearPhoto}
                    className="ml-2 inline-flex items-center gap-1 text-xs text-dues hover:underline">
              <IconX size={14} /> Remove
            </button>
          )}
        </div>
      </div>

      {/* Barcode */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[10rem] flex-1">
          <Field label="Barcode / QR code" placeholder="Scan or type a code"
                 value={line.barcode} onChange={set('barcode')} />
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
            onClick={() => onUseExisting(scanInfo.item)}
            className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-peacock px-3 py-2 text-sm font-semibold text-white hover:bg-peacock-700"
          >
            <IconCircleArrowRight size={17} /> Use this item on the bill
          </button>
        </div>
      )}
      {scanInfo?.tone === 'api' && (
        <p className="rounded-lg border border-profit/30 bg-profit/5 px-4 py-3 text-sm">
          Found online: <span className="font-semibold text-ink">{scanInfo.name}</span>. Name and photo
          were filled in — check them, then set your rates.
        </p>
      )}
      {scanInfo?.tone === 'none' && (
        <p className="rounded-lg bg-paper-2 px-4 py-3 text-sm text-muted">
          No matching product found. The code was saved — fill in the rest of the details.
        </p>
      )}

      <button type="button" onClick={() => setMore((m) => !m)}
              className="inline-flex items-center gap-1 text-sm font-medium text-peacock hover:underline">
        {more ? <IconChevronUp size={16} /> : <IconChevronDown size={16} />}
        {more ? 'Fewer details' : 'Shopfront details — description, tags, extra photos'}
      </button>

      {more && (
        <div className="space-y-4 rounded-lg border border-line bg-paper-2 p-4">
          <Textarea label="Description (optional)" rows={3} value={line.description}
                    onChange={set('description')}
                    placeholder="Shown on the shopfront item page — material, size, occasion…" />
          <TagsInput label="Tags (optional)" value={line.tags} onChange={(tags) => setVal('tags', tags)}
                     hint="Used for search & filtering, e.g. wedding, premium, handmade." />
          <ImagesInput label="More photos (optional)" value={line.images}
                       onChange={(images) => setVal('images', images)}
                       hint="Extra images shown in a gallery on the item page. The photo above stays the cover." />
        </div>
      )}

      {showScanner && <BarcodeScanner onClose={() => setShowScanner(false)} onDetected={handleDetected} />}
    </div>
  )
}

function Toggle({ label, hint, on, onChange }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg bg-paper-2 px-4 py-3">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted">{hint}</p>
      </div>
      <button type="button" onClick={onChange} aria-pressed={on}
              className={`relative h-6 w-11 shrink-0 rounded-full transition ${on ? 'bg-peacock' : 'bg-line'}`}>
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-card transition ${on ? 'left-[1.375rem]' : 'left-0.5'}`} />
      </button>
    </div>
  )
}

export function Dialog({ title, hint, children, onClose }) {
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-ink/40 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}
           className="mx-auto my-4 w-full max-w-2xl rounded-lg border border-line bg-card p-5 sm:p-6">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h3 className="font-[var(--font-display)] text-xl font-bold">{title}</h3>
            {hint && <p className="mt-0.5 text-sm text-muted">{hint}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close"
                  className="shrink-0 rounded-lg p-1 text-muted hover:bg-paper-2">
            <IconX size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function Section({ title, hint, children }) {
  return (
    <section className="rounded-lg border border-line bg-card p-5 sm:p-6">
      <h3 className="font-[var(--font-display)] text-lg font-bold">{title}</h3>
      {hint && <p className="mb-4 mt-0.5 text-sm text-muted">{hint}</p>}
      <div className="space-y-4">{children}</div>
    </section>
  )
}

// One labelled line in the bill breakdown (SPEC §3.2 — every number has a label).
export function Row({ label, value }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className="fig font-medium">{value}</dd>
    </div>
  )
}

export function Box({ label, value, tone }) {
  return (
    <div className="rounded-lg bg-paper-2 px-4 py-3">
      <p className="text-xs text-muted">{label}</p>
      <p className={`fig text-lg font-bold ${tone === 'dues' ? 'text-dues' : 'text-ink'}`}>{value}</p>
    </div>
  )
}

// =============================================================================
// Postage & tax on the bill (migration 036).
//
// Postage is typed off the paper bill. CGST/SGST work themselves out from each
// product's own GST slab (034) and only stop auto-filling once the owner types
// over them — a supplier's rounding rarely lands to the rupee, but making the
// owner re-key tax the products already carry is asking twice for one answer.
//
// `value` is the single source of truth for all three figures; this component
// only decides what to put in it, so the screens' totals and save paths never
// need to know whether a figure was typed or worked out.
// =============================================================================
export function BillCharges({ lines, value, onChange }) {
  const { shop } = useShop()
  // Figures we were handed are the ones already on the bill — the supplier's
  // real tax, off their paper. Start held, never auto-filled over: a bill being
  // CORRECTED must not have its tax silently rewritten the moment it is opened.
  // Entering a new bill starts blank, so it auto-fills as it always did.
  const [manual, setManual] = useState(() => Boolean(value.cgst || value.sgst))

  const suggested = suggestPurchaseGst(
    (lines || []).filter((l) => !isListingOnly(l)).map((l) => ({
      amount: lineCost(l),
      rate: itemGstRate(
        l.mode === 'new' ? combineGstRate(l.cgst_rate, l.sgst_rate) : l.item?.gst_rate,
        shop?.gst_rate,
      ),
    })),
    value.postage,
  )
  const autoCgst = suggested ? String(suggested.cgst) : ''
  const autoSgst = suggested ? String(suggested.sgst) : ''

  // Keep the boxes on the auto figure as lines are added, edited or removed.
  useEffect(() => {
    if (manual) return
    if (value.cgst === autoCgst && value.sgst === autoSgst) return
    onChange({ ...value, cgst: autoCgst, sgst: autoSgst })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manual, autoCgst, autoSgst])

  const set = (k) => (e) => onChange({ ...value, [k]: e.target.value })
  const setGst = (k) => (e) => { setManual(true); onChange({ ...value, [k]: e.target.value }) }

  // Typed figures that happen to equal the auto one aren't worth an "undo" link.
  const differs = manual
    && (round2(value.cgst || 0) !== (suggested?.cgst ?? 0)
     || round2(value.sgst || 0) !== (suggested?.sgst ?? 0))

  return (
    <Section
      title="Postage & tax on this bill"
      hint="Postage is typed off the bill. CGST and SGST work themselves out from the products' GST rates."
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Postage / freight" prefix="₹" type="number" min="0" step="0.01"
               inputMode="decimal" value={value.postage} onChange={set('postage')}
               hint="Courier, transport, packing" />
        <Field label="CGST" prefix="₹" type="number" min="0" step="0.01"
               inputMode="decimal" value={value.cgst} onChange={setGst('cgst')}
               hint={manual ? 'Typed by you' : 'Auto — from product GST'} />
        <Field label="SGST" prefix="₹" type="number" min="0" step="0.01"
               inputMode="decimal" value={value.sgst} onChange={setGst('sgst')}
               hint={manual ? 'Typed by you' : 'Auto — from product GST'} />
      </div>

      {differs ? (
        <button
          type="button"
          onClick={() => { setManual(false); onChange({ ...value, cgst: autoCgst, sgst: autoSgst }) }}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-peacock hover:underline"
        >
          <IconSparkles size={16} />
          Go back to the auto figure
          {suggested && <> — {money(suggested.cgst)} + {money(suggested.sgst)}</>}
        </button>
      ) : (
        <p className="inline-flex items-center gap-1.5 text-sm text-muted">
          <IconSparkles size={16} className="text-peacock" />
          {suggested
            ? `Worked out from each product's GST rate. Type over it if the supplier's bill says something different.`
            : `These products are nil-rated, so there is no GST on this bill. Type an amount if the supplier charged some.`}
        </p>
      )}

      <p className="text-xs text-muted">
        Postage and GST are added to what you owe this supplier, but never to a
        product's cost rate — postage is a bill expense and GST comes back as
        input credit, so your profit per item is unchanged.
      </p>
    </Section>
  )
}

// Upload a line's photo to the item-photos bucket, returning its public URL.
export async function uploadItemPhoto(shopId, file) {
  if (!file) return null
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase()
  const path = `${shopId}/${crypto.randomUUID()}.${ext}`
  const { error } = await supabase.storage
    .from('item-photos')
    .upload(path, file, { upsert: false, contentType: file.type })
  if (error) throw new Error('Photo upload failed: ' + error.message)
  return supabase.storage.from('item-photos').getPublicUrl(path).data.publicUrl
}

// Create the catalogue row for a `mode: 'new'` line, with NO opening stock.
// Stock arrives only through the purchases row that follows (Golden Rule #1),
// whichever screen is writing it. Returns { id, item_no, name }.
export async function createProductFromLine({ shopId, supplierId, line }) {
  const photo_url = (await uploadItemPhoto(shopId, line.photoFile)) || line.scannedPhotoUrl || null
  const { data, error } = await supabase
    .from('items')
    .insert({
      shop_id: shopId,
      name: line.name.trim(),
      company_no: line.company_no.trim() || null,
      supplier_id: supplierId,
      category_id: line.category_id,
      location: line.location.trim() || null,
      warehouse_id: line.warehouse_id || null,
      quantity: 0,
      purchase_rate: round2(line.purchase_rate),
      dealer_rate: round2(line.dealer_rate),
      rate: round2(line.rate),
      // Blank = no product rate; the shop's default GST rate applies.
      // CGST + SGST are two halves of one slab; the sum is what is stored.
      gst_rate: combineGstRate(line.cgst_rate, line.sgst_rate),
      hsn_sac: line.hsn_sac.trim() || null,
      low_stock_threshold: round2(line.low_stock_threshold || 10),
      moq: round2(line.moq || 1),
      barcode: line.barcode.trim() || null,
      photo_url,
      description: line.description.trim() || null,
      tags: line.tags,
      images: line.images,
      made_to_order: line.made_to_order,
      is_active: line.is_active,
    })
    .select('id, item_no, name, quantity, purchase_rate, gst_rate, low_stock_threshold, photo_url')
    .single()
  if (error) {
    if (isDuplicateCompanyNo(error)) {
      throw new Error(
        `Company No. "${line.company_no}" on "${line.name}" is already used by another item. ` +
          `Edit that line and use a different number, or leave it blank.`,
      )
    }
    throw new Error(`Could not add "${line.name}": ${error.message}`)
  }
  return data
}

export function SupplierModal({ shopId, onClose, onCreated }) {
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
