import { useState } from 'react'
import { Link } from 'react-router-dom'
import {
  IconUpload, IconFileSpreadsheet, IconDownload, IconCircleCheck,
  IconAlertTriangle, IconArrowLeft, IconPlus,
} from '@tabler/icons-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import { useShop } from '../../context/ShopContext'
import { money } from '../../lib/format'
import { round2 } from '../../lib/helpers'
import { parseCsv, toCsv, downloadText } from '../../lib/csv'
import { Button, Badge, Spinner } from '../../components/ui'

// SPEC §6.1 / §15 — Bulk Purchase Entry. Stock many new items in from a CSV in
// one pass. Every row still becomes an items row (quantity 0) + a purchases row,
// exactly like single Purchase Entry — so the same triggers raise stock, the
// supplier balance and the ledger (Golden Rules #1, #10). Unknown suppliers /
// categories are created on the fly (the owner chose auto-create).
const COLUMNS = [
  'name', 'company_no', 'supplier', 'category', 'location', 'quantity',
  'purchase_rate', 'dealer_rate', 'rate', 'low_stock_threshold', 'barcode', 'notes',
]

const TEMPLATE_ROW = {
  name: 'Wedding Card – Royal Red', company_no: '1420', supplier: 'Sharma Cards', category: 'Greeting Cards',
  location: 'R1-A', quantity: '100', purchase_rate: '12', dealer_rate: '18', rate: '25',
  low_stock_threshold: '10', barcode: '', notes: 'Bill #4521',
}

export default function BulkPurchase() {
  const { profile } = useAuth()
  const { shopId, suppliers, categories, refreshSuppliers, refreshCategories } = useShop()

  const [rows, setRows] = useState(null)   // parsed + validated rows, or null before upload
  const [fileName, setFileName] = useState('')
  const [parseErr, setParseErr] = useState('')
  const [importing, setImporting] = useState(false)
  const [results, setResults] = useState(null) // { ok, failed, newSuppliers, newCategories }

  // Case-insensitive name -> existing record id.
  const supplierByName = nameMap(suppliers)
  const categoryByName = nameMap(categories)

  function onFile(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setFileName(file.name); setParseErr(''); setResults(null)
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const { headers, rows: raw } = parseCsv(String(reader.result))
        const missing = COLUMNS.filter((c) => c !== 'barcode' && c !== 'notes' && c !== 'location' && c !== 'low_stock_threshold' && c !== 'company_no')
          .filter((c) => !headers.includes(c))
        if (missing.length) {
          setParseErr(`CSV is missing required column(s): ${missing.join(', ')}. Use the template.`)
          setRows(null); return
        }
        if (!raw.length) { setParseErr('No data rows found in the file.'); setRows(null); return }
        const validated = raw.map((r) => validateRow(r, supplierByName, categoryByName))
        // Company No. must be unique per shop (migration 031). Catch duplicates that
        // repeat WITHIN this file up front, so the owner fixes them before importing
        // rather than seeing half the batch fail at insert time.
        const seen = new Map()
        for (const row of validated) {
          const key = row.company_no.toLowerCase()
          if (!key) continue
          seen.set(key, (seen.get(key) || 0) + 1)
        }
        for (const row of validated) {
          const key = row.company_no.toLowerCase()
          if (key && seen.get(key) > 1) row.errors.push(`duplicate company_no "${row.company_no}" in file`)
        }
        setRows(validated)
      } catch (err) {
        setParseErr('Could not read that file: ' + (err.message || 'unknown error'))
        setRows(null)
      }
    }
    reader.readAsText(file)
    e.target.value = '' // allow re-selecting the same file
  }

  function downloadTemplate() {
    downloadText('purchase-template.csv', toCsv(COLUMNS, [TEMPLATE_ROW]))
  }

  const valid = rows?.filter((r) => r.errors.length === 0) ?? []
  const invalidCount = (rows?.length ?? 0) - valid.length
  const newSuppliers = uniqueNew(valid.map((r) => r.supplier), supplierByName)
  const newCategories = uniqueNew(valid.map((r) => r.category), categoryByName)

  async function runImport() {
    setImporting(true)
    const out = { ok: [], failed: [], newSuppliers: [], newCategories: [] }

    // Local maps start from what already exists, then grow as we create.
    const supMap = new Map(Object.entries(supplierByName))
    const catMap = new Map(Object.entries(categoryByName))

    try {
      // 1) Create any new suppliers / categories first, capturing their ids.
      for (const name of newSuppliers) {
        const { data, error } = await supabase.from('suppliers')
          .insert({ shop_id: shopId, name }).select('id').single()
        if (error) throw new Error(`Creating supplier "${name}" failed: ${error.message}`)
        supMap.set(name.toLowerCase(), data.id); out.newSuppliers.push(name)
      }
      for (const name of newCategories) {
        const { data, error } = await supabase.from('categories')
          .insert({ shop_id: shopId, name, type: 'finished_good' }).select('id').single()
        if (error) throw new Error(`Creating category "${name}" failed: ${error.message}`)
        catMap.set(name.toLowerCase(), data.id); out.newCategories.push(name)
      }
      if (out.newSuppliers.length) await refreshSuppliers()
      if (out.newCategories.length) await refreshCategories()

      // 2) Each valid row: item (quantity 0) then purchase — triggers do the rest.
      for (const r of valid) {
        const supplier_id = supMap.get(r.supplier.toLowerCase())
        const category_id = catMap.get(r.category.toLowerCase())
        try {
          const { data: item, error: itemErr } = await supabase.from('items').insert({
            shop_id: shopId, name: r.name, company_no: r.company_no || null, supplier_id, category_id,
            location: r.location || null, quantity: 0,
            purchase_rate: r.purchase_rate, dealer_rate: r.dealer_rate, rate: r.rate,
            low_stock_threshold: r.low_stock_threshold, barcode: r.barcode || null,
          }).select('id, item_no').single()
          if (itemErr) {
            if (itemErr.code === '23505' && /company_no/.test(itemErr.message || '')) {
              throw new Error(`Company No. "${r.company_no}" is already used by another item in this shop.`)
            }
            throw new Error(itemErr.message)
          }

          const total_cost = round2(r.quantity * r.purchase_rate)
          const { error: pErr } = await supabase.from('purchases').insert({
            shop_id: shopId, item_id: item.id, supplier_id,
            quantity: r.quantity, purchase_rate: r.purchase_rate, total_cost,
            entered_by: profile.id, notes: r.notes || null,
          })
          if (pErr) throw new Error(`item ${item.item_no} created but stock-in failed: ${pErr.message}`)
          out.ok.push({ name: r.name, item_no: item.item_no, total_cost })
        } catch (err) {
          out.failed.push({ name: r.name, error: err.message })
        }
      }
      setResults(out)
      setRows(null)
    } catch (err) {
      // A pre-flight (supplier/category) failure — nothing item-level ran.
      setParseErr(err.message)
    } finally {
      setImporting(false)
    }
  }

  // ---- Results screen ----
  if (results) return <Results results={results} onAgain={() => { setResults(null); setFileName('') }} />

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex items-center justify-between gap-3">
        <Link to="/owner/purchase" className="inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-ink">
          <IconArrowLeft size={17} /> Single Purchase Entry
        </Link>
        <Button variant="ghost" onClick={downloadTemplate}>
          <IconDownload size={18} /> Download template
        </Button>
      </div>

      <div>
        <h1 className="font-[var(--font-display)] text-2xl font-bold">Bulk purchase — CSV import</h1>
        <p className="mt-0.5 text-muted">
          Stock in many new items at once. Each becomes a Purchase Entry, so stock and
          supplier balances update the same way. New suppliers / categories are created automatically.
        </p>
      </div>

      {parseErr && (
        <p className="rounded-lg border border-dues/30 bg-dues/10 px-4 py-3 text-sm text-dues">{parseErr}</p>
      )}

      {/* Upload */}
      <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-line bg-card px-6 py-10 text-center hover:border-peacock/50 hover:bg-paper-2">
        <IconUpload size={30} className="text-muted" />
        <span className="font-semibold">{fileName || 'Choose a CSV file'}</span>
        <span className="text-xs text-muted">
          Columns: {COLUMNS.join(', ')}
        </span>
        <input type="file" accept=".csv,text/csv" className="hidden" onChange={onFile} />
      </label>

      {/* Preview */}
      {rows && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="inline-flex items-center gap-1.5 font-medium text-profit">
              <IconCircleCheck size={17} /> {valid.length} ready
            </span>
            {invalidCount > 0 && (
              <span className="inline-flex items-center gap-1.5 font-medium text-dues">
                <IconAlertTriangle size={17} /> {invalidCount} with problems (skipped)
              </span>
            )}
            {newSuppliers.length > 0 && <Badge tone="saffron">{newSuppliers.length} new supplier(s)</Badge>}
            {newCategories.length > 0 && <Badge tone="saffron">{newCategories.length} new categor(y/ies)</Badge>}
          </div>

          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-left text-sm">
              <thead className="bg-paper-2 text-xs uppercase tracking-wider text-muted">
                <tr>
                  <Th>#</Th><Th>Item</Th><Th>Company No.</Th><Th>Supplier</Th><Th>Category</Th>
                  <Th right>Qty</Th><Th right>Cost</Th><Th right>Dealer</Th><Th right>Retail</Th><Th>Status</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r, i) => (
                  <tr key={i} className={r.errors.length ? 'bg-dues/5' : ''}>
                    <Td className="text-muted">{i + 2}</Td>
                    <Td className="font-medium">{r.name || <span className="text-dues">—</span>}</Td>
                    <Td className="fig text-muted">{r.company_no || '—'}</Td>
                    <Td><NameCell name={r.supplier} isNew={r.supplier && !supplierByName[r.supplier.toLowerCase()]} /></Td>
                    <Td><NameCell name={r.category} isNew={r.category && !categoryByName[r.category.toLowerCase()]} /></Td>
                    <Td right className="fig">{r.raw.quantity}</Td>
                    <Td right className="fig">{r.raw.purchase_rate}</Td>
                    <Td right className="fig">{r.raw.dealer_rate}</Td>
                    <Td right className="fig">{r.raw.rate}</Td>
                    <Td>
                      {r.errors.length
                        ? <span className="text-xs text-dues">{r.errors.join('; ')}</span>
                        : <span className="text-xs text-profit">Ready</span>}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center gap-3">
            <Button onClick={runImport} disabled={importing || valid.length === 0} className="px-6">
              {importing ? <><Spinner /> Importing…</> : <><IconPlus size={18} /> Import {valid.length} item{valid.length === 1 ? '' : 's'}</>}
            </Button>
            <button onClick={() => { setRows(null); setFileName('') }} className="text-sm font-medium text-muted hover:text-ink">
              Clear
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ---- helpers ----
function nameMap(list) {
  const m = {}
  for (const x of list || []) m[(x.name || '').toLowerCase()] = x.id
  return m
}

// Distinct names (preserving display case) present in `names` but not in `existing`.
function uniqueNew(names, existing) {
  const seen = new Set()
  const out = []
  for (const n of names) {
    const key = (n || '').toLowerCase()
    if (!key || existing[key] || seen.has(key)) continue
    seen.add(key); out.push(n)
  }
  return out
}

// Validate one raw CSV row; returns a normalised row with numeric fields coerced
// and an errors[] list. Mirrors PurchaseEntry.validate() (SPEC §6.1).
function validateRow(raw, supplierByName, categoryByName) {
  const errors = []
  const num = (v) => (v === '' || v == null ? NaN : Number(v))
  const name = (raw.name || '').trim()
  const supplier = (raw.supplier || '').trim()
  const category = (raw.category || '').trim()
  const quantity = num(raw.quantity)
  const purchase_rate = num(raw.purchase_rate)
  const dealer_rate = num(raw.dealer_rate)
  const rate = num(raw.rate)
  const lowRaw = (raw.low_stock_threshold || '').trim()
  const low_stock_threshold = lowRaw === '' ? 10 : num(lowRaw)

  if (!name) errors.push('name required')
  if (!supplier) errors.push('supplier required')
  if (!category) errors.push('category required')
  if (!(quantity > 0)) errors.push('quantity must be > 0')
  if (!(purchase_rate >= 0)) errors.push('bad purchase_rate')
  if (!(dealer_rate >= 0)) errors.push('bad dealer_rate')
  if (!(rate >= 0)) errors.push('bad rate')
  if (!(low_stock_threshold >= 0)) errors.push('bad low_stock_threshold')

  return {
    raw, name, supplier, category,
    company_no: (raw.company_no || '').trim(),
    location: (raw.location || '').trim(),
    barcode: (raw.barcode || '').trim(),
    notes: (raw.notes || '').trim(),
    quantity: round2(quantity), purchase_rate: round2(purchase_rate),
    dealer_rate: round2(dealer_rate), rate: round2(rate),
    low_stock_threshold: round2(low_stock_threshold),
    errors,
  }
}

function NameCell({ name, isNew }) {
  if (!name) return <span className="text-dues">—</span>
  return (
    <span className="inline-flex items-center gap-1.5">
      {name}
      {isNew && <Badge tone="saffron">new</Badge>}
    </span>
  )
}

function Th({ children, right }) {
  return <th className={`px-3 py-2 font-semibold ${right ? 'text-right' : ''}`}>{children}</th>
}
function Td({ children, right, className = '' }) {
  return <td className={`px-3 py-2 ${right ? 'text-right' : ''} ${className}`}>{children}</td>
}

function Results({ results, onAgain }) {
  const { ok, failed, newSuppliers, newCategories } = results
  const totalCost = ok.reduce((s, r) => s + Number(r.total_cost || 0), 0)
  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div className="rounded-lg border border-line bg-card p-6 text-center">
        <div className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-full bg-profit/10 text-profit">
          <IconCircleCheck size={30} />
        </div>
        <h2 className="font-[var(--font-display)] text-2xl font-bold">Import finished</h2>
        <p className="mt-1 text-muted">
          <span className="font-semibold text-ink">{ok.length}</span> item{ok.length === 1 ? '' : 's'} stocked in
          {failed.length > 0 && <> · <span className="font-semibold text-dues">{failed.length}</span> failed</>}
        </p>
        <div className="mt-4 inline-flex flex-wrap justify-center gap-x-6 gap-y-1 text-sm">
          <span className="text-muted">Total purchase cost <span className="fig font-semibold text-dues">{money(totalCost)}</span></span>
          {newSuppliers.length > 0 && <span className="text-muted">New suppliers <span className="font-semibold text-ink">{newSuppliers.length}</span></span>}
          {newCategories.length > 0 && <span className="text-muted">New categories <span className="font-semibold text-ink">{newCategories.length}</span></span>}
        </div>
      </div>

      {failed.length > 0 && (
        <div className="rounded-lg border border-dues/30 bg-dues/5 p-5">
          <p className="mb-2 flex items-center gap-1.5 font-semibold text-dues">
            <IconAlertTriangle size={18} /> These rows were not imported
          </p>
          <ul className="space-y-1 text-sm">
            {failed.map((f, i) => (
              <li key={i}><span className="font-medium">{f.name || '(no name)'}</span> — <span className="text-muted">{f.error}</span></li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex gap-3">
        <Button onClick={onAgain}><IconFileSpreadsheet size={18} /> Import another file</Button>
        <Link to="/owner/inventory" className="inline-flex items-center rounded-lg border border-line bg-card px-4 py-2.5 text-sm font-semibold hover:bg-paper-2">
          View Inventory
        </Link>
      </div>
    </div>
  )
}
