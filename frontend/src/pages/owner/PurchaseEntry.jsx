import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  IconCamera, IconPlus, IconBarcode, IconCircleCheck, IconX, IconFileSpreadsheet,
  IconScan, IconTrash, IconPencil, IconSearch, IconPackage,
  IconSparkles, IconChevronDown, IconChevronUp,
} from '@tabler/icons-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import { useShop } from '../../context/ShopContext'
import { money, qty } from '../../lib/format'
import { round2, isDuplicateCompanyNo } from '../../lib/helpers'
import { Button, Field, Select, Textarea, Spinner, StockBadge, TagsInput, ImagesInput, Badge } from '../../components/ui'
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
//   • supplier bill  → /owner/purchase           (one bill, many line items)
//   • quick restock  → /owner/purchase?item=<id> (top up one existing item)
// Both honour Golden Rule #1: stock only ever rises via a purchases row, whose
// trigger raises items.quantity, the supplier balance and the ledger.
export default function PurchaseEntry() {
  const [params] = useSearchParams()
  const itemId = params.get('item')
  return itemId ? <RestockEntry itemId={itemId} /> : <BillEntry />
}

// A blank "new product" line. Mirrors the items table (SPEC §7.5).
const BLANK_NEW = {
  mode: 'new',
  name: '', company_no: '', category_id: '', location: '',
  quantity: '', purchase_rate: '', dealer_rate: '', rate: '',
  low_stock_threshold: '10', moq: '1', barcode: '',
  description: '', tags: [], images: [],
  made_to_order: false, is_active: true,
  photoFile: null, photoPreview: '', scannedPhotoUrl: '',
}

const today = () => new Date().toISOString().slice(0, 10)

// =============================================================================
// Bill entry — one supplier invoice, many products (migration 033).
//
// A real invoice mixes repeat designs with brand-new ones, so every line is
// either an EXISTING item (restock) or a NEW product created on the spot. All
// lines are written as one multi-row INSERT so the statement trigger records a
// single ledger entry for the whole bill.
// =============================================================================
function BillEntry() {
  const { profile } = useAuth()
  const { shopId, suppliers, refreshSuppliers } = useShop()

  const [bill, setBill] = useState({ supplier_id: '', invoice_no: '', invoice_date: today() })
  const [lines, setLines] = useState([])
  const [editing, setEditing] = useState(null)  // { line, index } while the editor is open
  const [errors, setErrors] = useState({})
  const [topError, setTopError] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(null)
  const [showSupplier, setShowSupplier] = useState(false)

  const supplier = suppliers.find((s) => s.id === bill.supplier_id) || null

  const setBillField = (k) => (e) => {
    setBill((b) => ({ ...b, [k]: e.target.value }))
    setErrors((er) => ({ ...er, [k]: undefined }))
  }

  // Only stocked lines carry money. A Make-to-Order line lists the product but
  // buys nothing, so it adds ₹0 to the bill.
  const billTotal = lines.reduce((sum, l) => sum + lineCost(l), 0)
  const stockedCount = lines.filter((l) => !isListingOnly(l)).length

  function upsertLine(line) {
    setLines((ls) => {
      if (editing?.index == null) return [...ls, line]
      const next = [...ls]
      next[editing.index] = line
      return next
    })
    setEditing(null)
    setErrors((er) => ({ ...er, lines: undefined }))
  }

  function removeLine(i) {
    setLines((ls) => ls.filter((_, idx) => idx !== i))
  }

  function validate() {
    const e = {}
    if (!bill.supplier_id) e.supplier_id = 'Choose the supplier this bill came from.'
    if (!lines.length) e.lines = 'Add at least one product to this bill.'
    setErrors(e)
    return Object.keys(e).length === 0
  }

  async function uploadPhoto(file) {
    if (!file) return null
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase()
    const path = `${shopId}/${crypto.randomUUID()}.${ext}`
    const { error } = await supabase.storage
      .from('item-photos')
      .upload(path, file, { upsert: false, contentType: file.type })
    if (error) throw new Error('Photo upload failed: ' + error.message)
    return supabase.storage.from('item-photos').getPublicUrl(path).data.publicUrl
  }

  async function onSubmit(e) {
    e.preventDefault()
    setTopError('')
    if (!validate()) return
    setBusy(true)

    const groupId = crypto.randomUUID()
    const invoice_no = bill.invoice_no.trim() || null
    const invoice_date = bill.invoice_date || null
    const createdItems = []   // for the error message if the stock-in half fails

    try {
      // 1) Create a catalogue row for every NEW line, with NO opening stock —
      //    stock arrives only through the purchases insert below (Golden Rule #1).
      const rows = []
      for (const line of lines) {
        let itemId = line.item?.id

        if (line.mode === 'new') {
          const photo_url = (await uploadPhoto(line.photoFile)) || line.scannedPhotoUrl || null
          const { data: item, error: itemErr } = await supabase
            .from('items')
            .insert({
              shop_id: shopId,
              name: line.name.trim(),
              company_no: line.company_no.trim() || null,
              supplier_id: bill.supplier_id,
              category_id: line.category_id,
              location: line.location.trim() || null,
              quantity: 0,
              purchase_rate: round2(line.purchase_rate),
              dealer_rate: round2(line.dealer_rate),
              rate: round2(line.rate),
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
            .select('id, item_no, name')
            .single()
          if (itemErr) {
            if (isDuplicateCompanyNo(itemErr)) {
              throw new Error(
                `Company No. "${line.company_no}" on "${line.name}" is already used by another item. ` +
                  `Edit that line and use a different number, or leave it blank.`,
              )
            }
            throw new Error(`Could not add "${line.name}": ${itemErr.message}`)
          }
          itemId = item.id
          createdItems.push(item.item_no)
        }

        // Make-to-Order lines hold no stock, so they buy nothing on this bill.
        if (isListingOnly(line)) continue

        const quantity = round2(line.quantity)
        const purchase_rate = round2(line.purchase_rate)
        rows.push({
          shop_id: shopId,
          item_id: itemId,
          supplier_id: bill.supplier_id,
          quantity,
          purchase_rate,
          total_cost: round2(quantity * purchase_rate),
          entered_by: profile.id,
          notes: line.notes?.trim() || null,
          invoice_no,
          invoice_date,
          purchase_group_id: groupId,
        })
      }

      // 2) ONE multi-row insert. This must stay a single statement: the
      //    statement-level trigger (migration 033) writes exactly one ledger
      //    row per INSERT statement, so inserting line by line would give the
      //    supplier one ledger entry per product instead of one per bill.
      if (rows.length) {
        const { error: pErr } = await supabase.from('purchases').insert(rows)
        if (pErr) {
          throw new Error(
            createdItems.length
              ? `New products (${createdItems.join(', ')}) were added to your catalogue, but recording the ` +
                `stock-in failed: ${pErr.message}. They are sitting at 0 stock — restock them from Inventory.`
              : `Could not record this bill: ${pErr.message}`,
          )
        }
      }

      setDone({
        invoice_no,
        supplier: supplier?.name || 'supplier',
        lineCount: lines.length,
        stockedCount: rows.length,
        listedCount: lines.length - rows.length,
        billTotal: rows.reduce((s, r) => s + Number(r.total_cost), 0),
      })
      setBill({ supplier_id: '', invoice_no: '', invoice_date: today() })
      setLines([])
      setErrors({})
    } catch (err) {
      setTopError(err.message || 'Could not save this bill. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  if (done) return <BillSuccess done={done} onAnother={() => setDone(null)} />

  return (
    <div className="mx-auto max-w-3xl">
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

        {/* ---- Bill header ---- */}
        <Section title="Supplier bill" hint="One bill can hold as many products as the invoice lists.">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Select label="Company / Supplier" value={bill.supplier_id}
                      onChange={setBillField('supplier_id')} error={errors.supplier_id}>
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
            <Field label="Bill date" type="date" value={bill.invoice_date}
                   onChange={setBillField('invoice_date')}
                   hint="The date printed on the bill" />
          </div>
          <Field label="Bill / Invoice No. (optional)" placeholder="e.g. 4521"
                 value={bill.invoice_no} onChange={setBillField('invoice_no')}
                 hint="The supplier's own bill number — so you can find this purchase again" />
        </Section>

        {/* ---- Line items ---- */}
        <Section
          title="Products on this bill"
          hint="Add each product the invoice lists. Repeat items top up existing stock; new designs are added to your catalogue."
        >
          {lines.length === 0 ? (
            <div className="rounded-lg border-2 border-dashed border-line bg-paper-2 px-6 py-8 text-center">
              <IconPackage size={28} className="mx-auto text-muted" />
              <p className="mt-2 font-semibold">No products added yet</p>
              <p className="mt-0.5 text-sm text-muted">Add the first product from this bill below.</p>
            </div>
          ) : (
            <LinesTable lines={lines} onEdit={(i) => setEditing({ line: lines[i], index: i })} onRemove={removeLine} />
          )}

          {errors.lines && <p className="text-sm text-dues">{errors.lines}</p>}

          <div className="flex flex-wrap gap-3">
            <Button
              variant="ghost"
              onClick={() => setEditing({ line: { mode: 'existing', item: null, quantity: '', purchase_rate: '', notes: '' }, index: null })}
              disabled={!bill.supplier_id}
            >
              <IconSearch size={18} /> Add existing item
            </Button>
            <Button
              variant="ghost"
              onClick={() => setEditing({ line: { ...BLANK_NEW }, index: null })}
              disabled={!bill.supplier_id}
            >
              <IconSparkles size={18} /> Add new product
            </Button>
          </div>
          {!bill.supplier_id && (
            <p className="text-xs text-muted">Choose the supplier first — products are added against that supplier.</p>
          )}
        </Section>

        {/* ---- Total ---- */}
        {lines.length > 0 && (
          <div className="rounded-lg border border-line bg-card p-5 sm:p-6">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-semibold">
                Bill total
                <span className="ml-2 text-sm font-normal text-muted">
                  {stockedCount} product{stockedCount === 1 ? '' : 's'} stocking in
                </span>
              </span>
              <span className="fig text-2xl font-bold text-dues">{money(billTotal)}</span>
            </div>
            <p className="mt-1 text-sm text-muted">
              Added to {supplier?.name || 'this supplier'}'s balance due.
            </p>
          </div>
        )}

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={busy} className="px-6">
            {busy ? <><Spinner /> Saving…</> : 'Save bill & stock in'}
          </Button>
          <Link to="/owner/inventory" className="text-sm font-medium text-muted hover:text-ink">
            Cancel
          </Link>
        </div>
      </form>

      {editing && (
        <LineEditor
          key={editing.index ?? 'new'}
          initial={editing.line}
          shopId={shopId}
          supplierId={bill.supplier_id}
          onClose={() => setEditing(null)}
          onSave={upsertLine}
        />
      )}

      {showSupplier && (
        <SupplierModal
          shopId={shopId}
          onClose={() => setShowSupplier(false)}
          onCreated={async (id) => {
            await refreshSuppliers()
            setBill((b) => ({ ...b, supplier_id: id }))
            setErrors((er) => ({ ...er, supplier_id: undefined }))
            setShowSupplier(false)
          }}
        />
      )}
    </div>
  )
}

// A Make-to-Order product is listed, never stocked — so it never becomes a
// purchases row and contributes nothing to the bill total.
function isListingOnly(line) {
  return line.mode === 'new' && line.made_to_order
}

function lineName(line) {
  return line.mode === 'new' ? line.name : line.item?.name || ''
}

function lineCost(line) {
  if (isListingOnly(line)) return 0
  return round2(Number(line.quantity || 0) * Number(line.purchase_rate || 0))
}

function LinesTable({ lines, onEdit, onRemove }) {
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
function LineEditor({ initial, shopId, supplierId, onClose, onSave }) {
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

  const cost = lineCost(line)

  return (
    <Dialog title={isNew ? 'New product on this bill' : 'Add existing item'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-5">
        {isNew
          ? <NewProductFields line={line} set={set} setVal={setVal} errors={errors} shopId={shopId} />
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

        <div className="flex justify-end gap-3 pt-1">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit"><IconPlus size={18} /> {initial.item || initial.name ? 'Save line' : 'Add to bill'}</Button>
        </div>
      </form>
    </Dialog>
  )
}

// ---- Existing item mode: search the catalogue, then top it up ----
function ExistingItemFields({ line, setVal, errors, shopId, supplierId }) {
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
      .select('id, item_no, name, company_no, quantity, purchase_rate, low_stock_threshold, supplier_id, discontinued')
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

// ---- New product mode: the full catalogue form, advanced fields folded away ----
function NewProductFields({ line, set, setVal, errors, shopId }) {
  const { categories } = useShop()
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
      .select('id, item_no, name, quantity')
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
        .select('id, item_no, name, quantity')
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
          <p className="mt-1 text-muted">
            Close this and use <span className="font-medium text-ink">Add existing item</span> instead,
            so this bill tops up that product rather than creating a duplicate.
          </p>
        </div>
      )}

      <Select label="Category" value={line.category_id} onChange={set('category_id')} error={errors.category_id}>
        <option value="">Select category…</option>
        {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </Select>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Dealer Rate" prefix="₹" type="number" min="0" step="0.01" inputMode="decimal"
               value={line.dealer_rate} onChange={set('dealer_rate')} error={errors.dealer_rate} />
        <Field label="Rate (retail)" prefix="₹" type="number" min="0" step="0.01" inputMode="decimal"
               value={line.rate} onChange={set('rate')} error={errors.rate} />
      </div>

      <button type="button" onClick={() => setMore((m) => !m)}
              className="inline-flex items-center gap-1 text-sm font-medium text-peacock hover:underline">
        {more ? <IconChevronUp size={16} /> : <IconChevronDown size={16} />}
        {more ? 'Fewer details' : 'More details — photo, barcode, rack, tags'}
      </button>

      {more && (
        <div className="space-y-4 rounded-lg border border-line bg-paper-2 p-4">
          {/* Make to Order — listed on the shopfront but never stocked. */}
          <Toggle
            label="Make to Order (no stock limit)"
            hint="Always shown on the shopfront. Buyers can order any quantity — nothing is stocked in on this bill."
            on={line.made_to_order}
            onChange={() => setVal('made_to_order', !line.made_to_order)}
          />
          <Toggle
            label="Active on storefront"
            hint="Show this product on your public shopfront."
            on={line.is_active}
            onChange={() => setVal('is_active', !line.is_active)}
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Location / Rack No" placeholder="e.g. R1-A"
                   value={line.location} onChange={set('location')} />
            <Field label="Min order qty (MOQ)" type="number" min="1" inputMode="decimal"
                   value={line.moq} onChange={set('moq')} error={errors.moq}
                   hint="Least a customer can order" />
          </div>
          {!line.made_to_order && (
            <Field label="Low stock threshold" type="number" min="0" inputMode="decimal"
                   value={line.low_stock_threshold} onChange={set('low_stock_threshold')}
                   hint="Flag as Low below this" />
          )}

          {/* Photo */}
          <div className="flex flex-wrap items-start gap-4">
            <div className="h-24 w-24 shrink-0 overflow-hidden rounded-lg border border-line bg-card">
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
              <p className="mt-1 text-muted">
                Close this and use <span className="font-medium text-ink">Add existing item</span> to top it up.
              </p>
            </div>
          )}
          {scanInfo?.tone === 'api' && (
            <p className="rounded-lg border border-profit/30 bg-profit/5 px-4 py-3 text-sm">
              Found online: <span className="font-semibold text-ink">{scanInfo.name}</span>. Name and photo
              were filled in — check them, then set your rates.
            </p>
          )}
          {scanInfo?.tone === 'none' && (
            <p className="rounded-lg bg-card px-4 py-3 text-sm text-muted">
              No matching product found. The code was saved — fill in the rest below.
            </p>
          )}

          <Textarea label="Description (optional)" rows={3} value={line.description}
                    onChange={set('description')}
                    placeholder="Shown on the shopfront item page — material, size, occasion…" />
          <TagsInput label="Tags (optional)" value={line.tags} onChange={(tags) => setVal('tags', tags)}
                     hint="Used for search & filtering, e.g. wedding, premium, handmade." />
          <ImagesInput label="More photos (optional)" value={line.images}
                       onChange={(images) => setVal('images', images)}
                       hint="Extra images shown in a gallery on the item page." />
        </div>
      )}

      {showScanner && <BarcodeScanner onClose={() => setShowScanner(false)} onDetected={handleDetected} />}
    </div>
  )
}

function Toggle({ label, hint, on, onChange }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg bg-card px-4 py-3">
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

function Dialog({ title, children, onClose }) {
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-ink/40 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}
           className="mx-auto my-4 w-full max-w-2xl rounded-lg border border-line bg-card p-5 sm:p-6">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-[var(--font-display)] text-xl font-bold">{title}</h3>
          <button type="button" onClick={onClose} aria-label="Close"
                  className="rounded-lg p-1 text-muted hover:bg-paper-2">
            <IconX size={20} />
          </button>
        </div>
        {children}
      </div>
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

function BillSuccess({ done, onAnother }) {
  return (
    <div className="mx-auto max-w-md rounded-lg border border-line bg-card p-8 text-center">
      <div className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-full bg-profit/10 text-profit">
        <IconCircleCheck size={34} />
      </div>
      <h2 className="font-[var(--font-display)] text-2xl font-bold">Bill saved</h2>
      <p className="mt-1 text-muted">
        {done.invoice_no
          ? <>Bill <span className="fig font-semibold text-ink">{done.invoice_no}</span> from {done.supplier}</>
          : <>Purchase from {done.supplier}</>}
      </p>
      <div className="mt-5 grid grid-cols-2 gap-3 text-left">
        <Box label="Products stocked in" value={String(done.stockedCount)} />
        <Box label="Added to supplier due" value={money(done.billTotal)} tone="dues" />
      </div>
      {done.listedCount > 0 && (
        <p className="mt-3 rounded-lg bg-peacock/5 px-4 py-2.5 text-left text-sm text-muted">
          {done.listedCount} Make-to-Order product{done.listedCount === 1 ? ' was' : 's were'} listed on the
          shopfront. They hold no stock, so they add nothing to this bill.
        </p>
      )}
      <div className="mt-6 flex justify-center gap-3">
        <Button onClick={onAnother}><IconPlus size={18} /> Enter another bill</Button>
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

// =============================================================================
// Quick restock (SPEC §6.9 — reached from Stock Inquiry's low list and Reports).
// One item, one line, no bill to build: the fastest path when a single product
// runs low. Left ungrouped, so its ledger entry names the item rather than a
// bill. Multi-product invoices go through Bill entry above.
// =============================================================================
function RestockEntry({ itemId }) {
  const { profile } = useAuth()
  const { shopId } = useShop()
  const [item, setItem] = useState(null)
  const [loadErr, setLoadErr] = useState('')
  const [form, setForm] = useState({ quantity: '', purchase_rate: '', invoice_no: '', invoice_date: today(), notes: '' })
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
        invoice_no: form.invoice_no.trim() || null,
        invoice_date: form.invoice_date || null,
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
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Bill / Invoice No. (optional)" placeholder="e.g. 4521"
                   value={form.invoice_no} onChange={set('invoice_no')}
                   hint="The supplier's own bill number" />
            <Field label="Bill date" type="date" value={form.invoice_date} onChange={set('invoice_date')} />
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
                  onChange={set('notes')} placeholder="Batch, damage, anything to remember" />

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
