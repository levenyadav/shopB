import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  IconPlus, IconCircleCheck, IconFileSpreadsheet, IconSearch, IconPackage, IconSparkles,
} from '@tabler/icons-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import { useShop } from '../../context/ShopContext'
import { money, qty } from '../../lib/format'
import { round2, purchaseBillTotals } from '../../lib/helpers'
import { Button, Field, Select, Textarea, Spinner, StockBadge } from '../../components/ui'
// The bill-building UI is shared with Purchase Bill Detail, which corrects an
// already-entered bill (migration 039) and must offer exactly these options.
import {
  BLANK_NEW, today, isListingOnly, lineCost,
  LinesTable, LineEditor, BillCharges, SupplierModal,
  Section, Row, Box, createProductFromLine,
} from '../../components/purchase'

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
  const { shopId, shop, suppliers, warehouses, refreshSuppliers } = useShop()

  const [bill, setBill] = useState({
    supplier_id: '', invoice_no: '', invoice_date: today(),
    postage: '', cgst: '', sgst: '', warehouse_id: '',
  })
  const [lines, setLines] = useState([])
  const [editing, setEditing] = useState(null)  // { line, index } while the editor is open
  const [errors, setErrors] = useState({})
  const [topError, setTopError] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(null)
  const [showSupplier, setShowSupplier] = useState(false)

  const supplier = suppliers.find((s) => s.id === bill.supplier_id) || null

  // Default to Main Warehouse (or the only one) once warehouses load, so a
  // shop with one warehouse never has to think about this field.
  useEffect(() => {
    if (!bill.warehouse_id && warehouses.length) {
      const main = warehouses.find((w) => w.name === 'Main Warehouse') || warehouses[0]
      setBill((b) => (b.warehouse_id ? b : { ...b, warehouse_id: main.id }))
    }
  }, [warehouses])

  const setBillField = (k) => (e) => {
    setBill((b) => ({ ...b, [k]: e.target.value }))
    setErrors((er) => ({ ...er, [k]: undefined }))
  }

  // Only stocked lines carry money. A Make-to-Order line lists the product but
  // buys nothing, so it adds ₹0 to the bill.
  const goodsTotal = lines.reduce((sum, l) => sum + lineCost(l), 0)
  const stockedCount = lines.filter((l) => !isListingOnly(l)).length

  // Goods + postage + the tax the supplier charged = what this supplier is owed.
  // Postage is pass-through and GST is input credit, so neither lands in cost
  // (migration 036) — the products' rates are unaffected by anything here.
  const totals = purchaseBillTotals({
    goods: goodsTotal, postage: bill.postage, cgst: bill.cgst, sgst: bill.sgst,
  })

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
          const item = await createProductFromLine({
            shopId, supplierId: bill.supplier_id, line,
          })
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
          warehouse_id: bill.warehouse_id || null,
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

      // 3) Postage and the supplier's GST, booked SECOND and separately: the
      //    goods are already on the supplier's balance (033), and this row's own
      //    trigger (036) adds the non-goods money in one further ledger entry.
      //    Written only when there is something to write, and only when the bill
      //    has real lines to hang off — a listing-only bill charges nothing.
      const bookedGoods = rows.reduce((s, r) => s + Number(r.total_cost), 0)
      const billCharges = purchaseBillTotals({
        goods: bookedGoods, postage: bill.postage, cgst: bill.cgst, sgst: bill.sgst,
      })
      if (rows.length && (billCharges.postage > 0 || billCharges.tax > 0)) {
        const { error: cErr } = await supabase.from('purchase_bills').insert({
          shop_id: shopId,
          supplier_id: bill.supplier_id,
          purchase_group_id: groupId,
          goods_total: billCharges.goods,
          postage: billCharges.postage,
          cgst_amount: billCharges.cgst,
          sgst_amount: billCharges.sgst,
          grand_total: billCharges.grand,
        })
        // The stock and the goods money are already safely recorded, so this is
        // never a reason to fail the whole bill — say exactly what is missing
        // and what it means, per SPEC §3 (no dead ends).
        if (cErr) {
          throw new Error(
            `The bill and stock were saved, but the postage / GST on it was not: ${cErr.message}. ` +
              `${supplier?.name || 'The supplier'}'s balance is short by ` +
              `${money(billCharges.postage + billCharges.tax)} — add it as a separate entry, ` +
              `or check that migration 036 has been run.`,
          )
        }
      }

      setDone({
        invoice_no,
        supplier: supplier?.name || 'supplier',
        lineCount: lines.length,
        stockedCount: rows.length,
        listedCount: lines.length - rows.length,
        billTotal: bookedGoods,
        postage: billCharges.postage,
        tax: billCharges.tax,
        grandTotal: rows.length ? billCharges.grand : 0,
      })
      setBill({ supplier_id: '', invoice_no: '', invoice_date: today(), postage: '', cgst: '', sgst: '' })
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
          {warehouses.length > 1 && (
            <Select label="Warehouse" value={bill.warehouse_id} onChange={setBillField('warehouse_id')}
                    hint="Where this stock is being received">
              {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </Select>
          )}
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

        {/* ---- Postage & tax on this bill (migration 036) ---- */}
        {lines.length > 0 && (
          <BillCharges
            lines={lines}
            value={{ postage: bill.postage, cgst: bill.cgst, sgst: bill.sgst }}
            onChange={(v) => setBill((b) => ({ ...b, ...v }))}
          />
        )}

        {/* ---- Total ---- */}
        {lines.length > 0 && (
          <div className="rounded-lg border border-line bg-card p-5 sm:p-6">
            <dl className="space-y-1.5 text-sm">
              <Row label={`Goods (${stockedCount} product${stockedCount === 1 ? '' : 's'} stocking in)`}
                   value={money(totals.goods)} />
              {totals.postage > 0 && <Row label="Postage / freight" value={money(totals.postage)} />}
              {totals.cgst > 0 && <Row label="CGST" value={money(totals.cgst)} />}
              {totals.sgst > 0 && <Row label="SGST" value={money(totals.sgst)} />}
            </dl>
            <div className="mt-3 flex flex-wrap items-baseline justify-between gap-2 border-t border-line pt-3">
              <span className="font-semibold">Bill total</span>
              <span className="fig text-2xl font-bold text-dues">{money(totals.grand)}</span>
            </div>
            <p className="mt-1 text-sm text-muted">
              Added to {supplier?.name || 'this supplier'}'s balance due.
              {totals.tax > 0 && ` ${money(totals.tax)} of it is GST you can claim back.`}
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
        <Box label="Added to supplier due" value={money(done.grandTotal || done.billTotal)} tone="dues" />
      </div>
      {(done.postage > 0 || done.tax > 0) && (
        <p className="mt-3 rounded-lg bg-paper-2 px-4 py-2.5 text-left text-sm text-muted">
          Goods {money(done.billTotal)}
          {done.postage > 0 && <> · postage {money(done.postage)}</>}
          {done.tax > 0 && <> · GST {money(done.tax)} (claimable)</>}
        </p>
      )}
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


// =============================================================================
// Quick restock (SPEC §6.9 — reached from Stock Inquiry's low list and Reports).
// One item, one line, no bill to build: the fastest path when a single product
// runs low. Left ungrouped, so its ledger entry names the item rather than a
// bill. Multi-product invoices go through Bill entry above.
// =============================================================================
function RestockEntry({ itemId }) {
  const { profile } = useAuth()
  const { shopId, warehouses } = useShop()
  const [item, setItem] = useState(null)
  const [loadErr, setLoadErr] = useState('')
  const [form, setForm] = useState({ quantity: '', purchase_rate: '', invoice_no: '', invoice_date: today(), notes: '', warehouse_id: '' })
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

  useEffect(() => {
    if (!form.warehouse_id && warehouses.length) {
      const main = warehouses.find((w) => w.name === 'Main Warehouse') || warehouses[0]
      setForm((f) => (f.warehouse_id ? f : { ...f, warehouse_id: main.id }))
    }
  }, [warehouses])

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
        warehouse_id: form.warehouse_id || null,
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
          {warehouses.length > 1 && (
            <Select label="Warehouse" value={form.warehouse_id} onChange={set('warehouse_id')}
                    hint="Where this stock is being received">
              {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </Select>
          )}
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

