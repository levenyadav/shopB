import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  IconArrowLeft, IconPrinter, IconEye, IconTag, IconTruck, IconUser, IconPhone, IconMapPin,
  IconPlus, IconX, IconDeviceFloppy, IconPencil, IconTrash, IconAlertTriangle,
} from '@tabler/icons-react'
import { supabase } from '../../lib/supabase'
import { useShop } from '../../context/ShopContext'
import { useAuth } from '../../context/AuthContext'
import { money, qty, dateTime, dateShort } from '../../lib/format'
import { round2, purchaseBillTotals, suggestPurchaseGst } from '../../lib/helpers'
import { buildPurchaseBillModel, viewPurchaseBill, printPurchaseBill } from '../../lib/purchaseBillTemplate'
import { Badge, Spinner, Button, PhotoThumb, Field, StockBadge } from '../../components/ui'

// SPEC §6.1 / §6.7.1 — one supplier bill, in full. Reached from the supplier's
// ledger (the `purchase` entry links straight here) and from Purchase History.
//
// The route id is any `purchases` row id, because that is exactly what the
// ledger stores: migration 033 points a bill's ledger row at the FIRST LINE of
// the bill, and every sibling line shares its purchase_group_id. Legacy rows
// predate grouping and are simply bills of one, so they land here too.
//
// The owner may CORRECT a bill from here (migration 039): quantities, cost
// rates, products added or taken off, postage and GST. Every one of those still
// moves stock and the supplier balance through triggers, and posts one further
// append-only ledger entry for the difference (Golden Rules #9, #10) — this page
// never writes a balance itself. See BillEditor at the bottom.
export default function PurchaseBillDetail() {
  const { id } = useParams()
  const { shop, currency } = useShop()
  const { role } = useAuth()
  const [bill, setBill] = useState(null)
  const [err, setErr] = useState('')
  const [missing, setMissing] = useState(false)
  const [reload, setReload] = useState(0)
  const [editing, setEditing] = useState(false)
  const [saved, setSaved] = useState(null)

  useEffect(() => {
    let active = true
    async function load() {
      setErr(''); setMissing(false); setBill(null)

      // Which bill is this? The row we were handed tells us its group.
      const { data: seed, error: seedErr } = await supabase
        .from('purchases').select('id, purchase_group_id').eq('id', id).maybeSingle()
      if (!active) return
      if (seedErr) { setErr(seedErr.message); return }
      if (!seed) { setMissing(true); return }

      const group = seed.purchase_group_id
      const COLUMNS =
        'id, shop_id, item_id, supplier_id, quantity, purchase_rate, total_cost, notes, created_at, ' +
        'invoice_no, invoice_date, purchase_group_id, ' +
        'item_no, item_name, ' +
        'item:items(id, name, item_no, photo_url, hsn_sac, gst_rate), ' +
        'supplier:suppliers(id, name, phone, contact_person, address), ' +
        'entered_by:profiles(full_name)'

      const runLines = (columns) => {
        let q = supabase.from('purchases').select(columns).order('created_at', { ascending: true })
        return group ? q.eq('purchase_group_id', group) : q.eq('id', id)
      }

      // `deleted_at` (039) marks a line taken off the bill by an edit. The app
      // may be running one migration ahead of the database, so a database that
      // has not had 039 yet falls back to the pre-039 query — where no line can
      // have been removed, so nothing is lost by not filtering.
      let editable = true
      let { data: lines, error: lineErr } = await runLines(`${COLUMNS}, deleted_at`)
      if (lineErr && /deleted_at/.test(lineErr.message || '')) {
        editable = false
        ;({ data: lines, error: lineErr } = await runLines(COLUMNS))
      }
      if (!active) return
      if (lineErr) { setErr(lineErr.message); return }
      if (!lines?.length) { setMissing(true); return }

      const live = lines.filter((l) => !l.deleted_at)
      const removed = lines.filter((l) => l.deleted_at)
      if (!live.length) { setMissing(true); return }

      // Postage / GST live in their own table (036) and are asked for separately:
      // migrations are applied by hand, so the app can run one ahead of the
      // database. A missing table must cost the charges line, not the page.
      //
      // The read is allowed to fail, but it is NOT allowed to fail silently:
      // swallowing the error makes an unreadable table look exactly like a bill
      // that genuinely had no postage or GST, and the owner is told a lie about
      // their own money. Keep the reason and say so on the page.
      let charges = null
      let chargesErr = ''
      if (group) {
        const { data, error } = await supabase
          .from('purchase_bills')
          .select('postage, cgst_amount, sgst_amount, grand_total, notes')
          .eq('purchase_group_id', group).maybeSingle()
        if (error) chargesErr = error.message
        charges = data || null
      } else {
        // No group → this bill predates migration 033, so it can never have a
        // charges row: 036 keys them on purchase_group_id.
        chargesErr = 'ungrouped'
      }
      if (!active) return

      const first = live[0]
      const goods = live.reduce((a, l) => a + Number(l.total_cost || 0), 0)
      const postage = Number(charges?.postage || 0)
      const cgst = Number(charges?.cgst_amount || 0)
      const sgst = Number(charges?.sgst_amount || 0)
      setBill({
        lines: live,
        removed,
        editable,
        group,
        shopId: first.shop_id,
        supplierId: first.supplier_id,
        supplier: first.supplier,
        invoice_no: live.find((l) => l.invoice_no)?.invoice_no || '',
        invoice_date: live.find((l) => l.invoice_date)?.invoice_date || null,
        createdAt: first.created_at,
        enteredBy: first.entered_by?.full_name,
        notes: charges?.notes || live.find((l) => l.notes)?.notes || '',
        pcs: live.reduce((a, l) => a + Number(l.quantity || 0), 0),
        goods, postage, cgst, sgst,
        grand: goods + postage + cgst + sgst,
        chargesErr,
      })
    }
    load()
    return () => { active = false }
  }, [id, reload])

  if (missing) return (
    <Empty>
      Purchase bill not found.{' '}
      <Link to="/owner/purchases" className="font-medium text-peacock hover:underline">Back to purchase history</Link>.
    </Empty>
  )
  if (err && !bill) return <Empty>{err}</Empty>
  if (!bill) return <div className="grid place-items-center py-20 text-muted"><Spinner /></div>

  const c = (n) => money(n).replace('₹', currency)
  const hasCharges = bill.postage > 0 || bill.cgst > 0 || bill.sgst > 0
  const doc = buildPurchaseBillModel({ shop, bill })

  if (editing) {
    return (
      <BillEditor
        bill={bill}
        currency={currency}
        onCancel={() => setEditing(false)}
        onSaved={(result) => {
          setEditing(false)
          setSaved(result)
          setReload((n) => n + 1)
        }}
      />
    )
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <Link to="/owner/purchases" className="no-print inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-ink">
        <IconArrowLeft size={17} /> Purchase history
      </Link>

      {/* What the last correction did to the books, in plain words. */}
      {saved && (
        <div className="no-print flex items-start justify-between gap-3 rounded-lg bg-profit/10 px-4 py-3 text-sm text-ink">
          <p>
            Bill corrected.{' '}
            {saved.difference === 0
              ? 'The total did not change, so nothing moved on the supplier’s balance.'
              : <>
                  Total {saved.difference > 0 ? 'went up' : 'came down'} from{' '}
                  <span className="fig font-semibold">{c(saved.old_total)}</span> to{' '}
                  <span className="fig font-semibold">{c(saved.new_total)}</span>, so{' '}
                  <span className="fig font-semibold">{c(Math.abs(saved.difference))}</span> was{' '}
                  {saved.difference > 0 ? 'added to' : 'taken off'}{' '}
                  {bill.supplier?.name || 'the supplier'}’s balance.
                </>}
          </p>
          <button type="button" onClick={() => setSaved(null)} className="shrink-0 text-muted hover:text-ink">
            <IconX size={16} />
          </button>
        </div>
      )}

      {/* Bill header */}
      <div className="rounded-lg border border-line bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              {bill.invoice_no
                ? <Badge tone="peacock"><IconTag size={13} className="inline -mt-0.5" /> {bill.invoice_no}</Badge>
                : <Badge tone="muted">No bill no.</Badge>}
              <h2 className="text-xl font-bold">Purchase bill</h2>
            </div>
            <p className="mt-1 text-sm text-muted">
              {bill.invoice_date ? `Bill date ${dateShort(bill.invoice_date)}` : `Entered ${dateTime(bill.createdAt)}`}
              {' · '}<span className="fig">{qty(bill.lines.length)}</span> item{bill.lines.length === 1 ? '' : 's'}
              {' · '}<span className="fig">{qty(bill.pcs)}</span> pcs
              {bill.enteredBy && ` · by ${bill.enteredBy}`}
            </p>
          </div>
          <div className="shrink-0 text-right">
            <p className="text-xs text-muted">Bill total</p>
            <p className="fig text-2xl font-bold">{c(bill.grand)}</p>
          </div>
        </div>

        {/* Supplier — links to their ledger, where this bill's entry lives */}
        {bill.supplier && (
          <div className="mt-4 rounded-lg bg-paper-2 px-4 py-3 text-sm">
            <p className="text-xs text-muted">Supplier</p>
            <Link
              to={`/owner/parties/supplier/${bill.supplier.id}`}
              className="font-semibold text-ink hover:text-peacock"
            >
              {bill.supplier.name}
            </Link>
            <p className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
              {bill.supplier.contact_person && <span className="inline-flex items-center gap-1"><IconUser size={13} /> {bill.supplier.contact_person}</span>}
              {bill.supplier.phone && <span className="fig inline-flex items-center gap-1"><IconPhone size={13} /> {bill.supplier.phone}</span>}
              {bill.supplier.address && <span className="inline-flex items-center gap-1"><IconMapPin size={13} /> {bill.supplier.address}</span>}
            </p>
          </div>
        )}
      </div>

      {/* Item lines */}
      <div className="overflow-hidden rounded-lg border border-line bg-card">
        <div className="border-b border-line bg-paper-2 px-5 py-2.5 text-xs font-semibold uppercase tracking-wider text-muted">
          Items on this bill
        </div>
        <ul className="divide-y divide-line">
          {bill.lines.map((l) => (
            <li key={l.id} className="flex items-center gap-3 px-5 py-3">
              <PhotoThumb url={l.item?.photo_url} size="h-12 w-12" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-ink">{l.item_name || l.item?.name || 'Item'}</p>
                <p className="text-xs text-muted">
                  {(l.item_no || l.item?.item_no) && <span className="fig">{l.item_no || l.item?.item_no} · </span>}
                  <span className="fig">{qty(l.quantity)}</span> pcs ×{' '}
                  <span className="fig">{c(l.purchase_rate)}</span> each
                </p>
              </div>
              <p className="fig shrink-0 font-semibold">{c(l.total_cost)}</p>
            </li>
          ))}
        </ul>

        {/* Bill totals. Postage and the supplier's GST (036) sit on top of goods
            and are never folded into an item's cost. */}
        <div className="space-y-1 border-t border-line bg-paper-2 px-5 py-3 text-sm">
          <Charge label="Goods total" value={c(bill.goods)} />
          {bill.postage > 0 && <Charge label="Postage / freight" value={c(bill.postage)} hint="Pass-through — not in item cost" />}
          {bill.cgst > 0 && <Charge label="CGST" value={c(bill.cgst)} />}
          {bill.sgst > 0 && <Charge label="SGST" value={c(bill.sgst)} />}
          <div className="flex items-center justify-between gap-3 border-t border-line pt-1.5 font-semibold">
            <span>Bill total (owed to supplier)</span>
            <span className="fig">{c(bill.grand)}</span>
          </div>
          {(bill.cgst > 0 || bill.sgst > 0) && (
            <p className="pt-1 text-xs text-muted">
              GST <span className="fig">{c(bill.cgst + bill.sgst)}</span> is claimable input credit — not part of product cost.
            </p>
          )}
          {/* "None recorded" and "couldn't be read" are different facts and must
              never look the same — the owner has to know which one they are
              looking at before trusting the total. */}
          {!hasCharges && !bill.chargesErr && (
            <p className="pt-1 text-xs text-muted">No postage or GST recorded on this bill.</p>
          )}
          {!hasCharges && bill.chargesErr === 'ungrouped' && (
            <p className="pt-1 text-xs text-muted">
              This bill predates multi-line bills, so postage and GST were never recorded against it.
            </p>
          )}
          {!hasCharges && bill.chargesErr && bill.chargesErr !== 'ungrouped' && (
            <p className="pt-1 text-xs text-dues">
              Postage and GST could not be read for this bill, so the total above is goods only.
              Fix: run migration 036 on the database. ({bill.chargesErr})
            </p>
          )}
        </div>
      </div>

      {/* A bill entered before migration 036 reached the database never got its
          charges row, and 036 books money on INSERT — applying the migration
          afterwards recovers nothing by itself. This puts that one missing
          insert back, so the trigger books it exactly as it would have on the
          day (Golden Rule #10 — the app never moves the balance itself). */}
      {!hasCharges && bill.group && !bill.chargesErr && (
        <BackfillCharges bill={bill} currency={currency} onSaved={() => setReload((n) => n + 1)} />
      )}

      {/* What was taken off this bill by an edit. Kept because a bill's history
          is part of the record: the owner should be able to see that a product
          was on it and is no longer, without hunting through the ledger. */}
      {bill.removed?.length > 0 && (
        <div className="no-print overflow-hidden rounded-lg border border-dashed border-line bg-card">
          <div className="border-b border-line bg-paper-2 px-5 py-2.5 text-xs font-semibold uppercase tracking-wider text-muted">
            Taken off this bill
          </div>
          <ul className="divide-y divide-line">
            {bill.removed.map((l) => (
              <li key={l.id} className="flex items-center gap-3 px-5 py-3 text-muted">
                <div className="min-w-0 flex-1">
                  <p className="truncate line-through">{l.item_name || l.item?.name || 'Item'}</p>
                  <p className="text-xs">
                    <span className="fig">{qty(l.quantity)}</span> pcs ×{' '}
                    <span className="fig">{c(l.purchase_rate)}</span> · removed {dateTime(l.deleted_at)}
                  </p>
                </div>
                <p className="fig shrink-0 line-through">{c(l.total_cost)}</p>
              </li>
            ))}
          </ul>
          <p className="border-t border-line px-5 py-2.5 text-xs text-muted">
            These pcs came back out of stock and off the supplier’s balance when they were removed.
          </p>
        </div>
      )}

      {bill.notes && (
        <div className="rounded-lg border border-line bg-card p-4 text-sm">
          <p className="text-xs text-muted">Note</p>
          <p className="text-ink">{bill.notes}</p>
        </div>
      )}

      <div className="no-print flex flex-wrap items-center gap-3">
        {role === 'owner' && bill.editable && (
          <Button onClick={() => { setSaved(null); setEditing(true) }}>
            <IconPencil size={18} /> Edit bill
          </Button>
        )}
        <Button variant="ghost" onClick={() => viewPurchaseBill(doc)}>
          <IconEye size={18} /> View bill document
        </Button>
        <Button variant="ghost" onClick={() => printPurchaseBill(doc)}>
          <IconPrinter size={18} /> Print / Save PDF
        </Button>
        {bill.supplier && (
          <Link
            to={`/owner/parties/supplier/${bill.supplier.id}`}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-ink"
          >
            <IconTruck size={17} /> Supplier ledger
          </Link>
        )}
      </div>

      {role === 'owner' && !bill.editable && (
        <p className="no-print text-xs text-muted">
          Bills can’t be corrected yet on this database. Fix: run migration 039 on it.
        </p>
      )}

      {err && bill && <p className="no-print rounded-lg bg-dues/10 px-4 py-3 text-sm text-dues">{err}</p>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Correcting a bill. One screen, everything editable at once (SPEC §3 — two
// screens maximum for any owner task): the lines, the products on it, the bill
// number and date, and the postage / GST.
//
// Nothing is written until Save, and Save is ONE call to edit_purchase_bill
// (migration 039), which applies the whole correction in a single transaction.
// A half-corrected bill is therefore impossible, and the stock and balance moves
// stay where they belong — in triggers, not here.
//
// The screen refuses in advance what the database would refuse: an edit that
// takes an item below zero stock, because those pcs have already been sold. The
// database is still the one enforcing it (039), but the owner should see it
// while typing, not after pressing Save.
// ---------------------------------------------------------------------------
let draftKey = 0
const nextKey = () => `new-${++draftKey}`

function BillEditor({ bill, currency, onCancel, onSaved }) {
  const c = (n) => money(n).replace('₹', currency)

  const [lines, setLines] = useState(() =>
    bill.lines.map((l) => ({
      key: l.id,
      id: l.id,
      item_id: l.item_id || l.item?.id || null,
      name: l.item_name || l.item?.name || 'Item',
      item_no: l.item_no || l.item?.item_no || '',
      photo_url: l.item?.photo_url || null,
      gst_rate: l.item?.gst_rate ?? null,
      quantity: String(l.quantity ?? ''),
      purchase_rate: String(l.purchase_rate ?? ''),
      notes: l.notes || '',
    })),
  )
  const [head, setHead] = useState({
    invoice_no: bill.invoice_no || '',
    // Already a YYYY-MM-DD date (not a timestamp), which is exactly what a date
    // input wants — parsing it through Date would shift it a day in some zones.
    invoice_date: bill.invoice_date ? String(bill.invoice_date).slice(0, 10) : '',
    postage: bill.postage ? String(bill.postage) : '',
    cgst: bill.cgst ? String(bill.cgst) : '',
    sgst: bill.sgst ? String(bill.sgst) : '',
    notes: bill.notes || '',
  })
  const [adding, setAdding] = useState(false)
  const [stock, setStock] = useState(null)     // item_id → { quantity, name, purchase_rate }
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const setHeadVal = (k) => (e) => { setHead((h) => ({ ...h, [k]: e.target.value })); setErr('') }
  const setLine = (key, k, v) => {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, [k]: v } : l)))
    setErr('')
  }

  // What is on the shelf right now, for every product this bill touches. Needed
  // to answer "can this line be cut?" before the owner presses Save.
  const itemIds = useMemo(
    () => [...new Set(lines.map((l) => l.item_id).filter(Boolean))].sort().join(','),
    [lines],
  )
  useEffect(() => {
    let active = true
    const ids = itemIds ? itemIds.split(',') : []
    if (!ids.length) { setStock({}); return }
    supabase
      .from('items')
      .select('id, name, quantity, purchase_rate, low_stock_threshold')
      .in('id', ids)
      .then(({ data, error }) => {
        if (!active) return
        if (error) { setErr(`Could not read current stock: ${error.message}`); return }
        const map = {}
        for (const it of data || []) map[it.id] = it
        setStock(map)
      })
    return () => { active = false }
  }, [itemIds])

  // Totals, live.
  const goods = round2(lines.reduce((a, l) => a + lineTotal(l), 0))
  const totals = purchaseBillTotals({ goods, postage: head.postage, cgst: head.cgst, sgst: head.sgst })
  const oldTotal = round2(bill.grand)
  const difference = round2(totals.grand - oldTotal)

  const suggested = suggestPurchaseGst(lines.map((l) => ({ amount: lineTotal(l), rate: l.gst_rate })))

  // Net change per product across the whole edit — the same sum migration 039
  // does — so moving pcs between two lines of one product is never wrongly
  // refused, and a genuine shortfall is named before Save.
  const shortfalls = useMemo(() => {
    if (!stock) return []
    const was = new Map()
    for (const l of bill.lines) {
      const k = l.item_id || l.item?.id
      if (k) was.set(k, (was.get(k) || 0) + Number(l.quantity || 0))
    }
    const now = new Map()
    for (const l of lines) {
      if (l.item_id) now.set(l.item_id, (now.get(l.item_id) || 0) + Number(l.quantity || 0))
    }
    const out = []
    for (const [itemId, before] of was) {
      const after = now.get(itemId) || 0
      const delta = round2(after - before)
      const onHand = Number(stock[itemId]?.quantity ?? 0)
      if (delta < 0 && round2(onHand + delta) < 0) {
        out.push({
          name: stock[itemId]?.name || bill.lines.find((l) => (l.item_id || l.item?.id) === itemId)?.item_name || 'this item',
          short: round2(-(onHand + delta)),
        })
      }
    }
    return out
  }, [lines, stock, bill.lines])

  // Cost rates the correction will push onto the catalogue (owner's rule: the
  // corrected cost becomes the product's cost, so future profit uses it).
  const costChanges = useMemo(() => {
    if (!stock) return []
    const seen = new Map()
    for (const l of lines) {
      if (!l.item_id || l.purchase_rate === '') continue
      const rate = round2(l.purchase_rate)
      const was = stock[l.item_id]?.purchase_rate
      if (was != null && round2(was) !== rate) {
        seen.set(l.item_id, { id: l.item_id, name: stock[l.item_id]?.name || l.name, from: round2(was), to: rate })
      }
    }
    return [...seen.values()]
  }, [lines, stock])

  function validate() {
    if (!lines.length) return 'A bill must have at least one product. Add one, or press Cancel to leave the bill as it is.'
    for (const l of lines) {
      if (!l.item_id) return `"${l.name}" is not linked to a product, so it can't be edited. Remove the line and add the product again.`
      if (l.quantity === '' || !(Number(l.quantity) > 0)) return `Enter how many pcs of "${l.name}" this bill was for.`
      if (l.purchase_rate === '' || Number(l.purchase_rate) < 0) return `Enter the cost rate for "${l.name}".`
    }
    if (shortfalls.length) {
      return `Not enough stock for this change: ${shortfalls
        .map((s) => `${s.name} (short by ${qty(s.short)} pcs)`)
        .join(', ')}. Those pcs have already been sold, so the bill can't be cut that far.`
    }
    return ''
  }

  async function save(e) {
    e.preventDefault()
    const problem = validate()
    if (problem) { setErr(problem); return }
    setSaving(true); setErr('')

    const { data, error } = await supabase.rpc('edit_purchase_bill', {
      p_bill_id: bill.lines[0].id,
      p_lines: lines.map((l) => ({
        id: l.id || null,
        item_id: l.item_id,
        quantity: round2(l.quantity),
        purchase_rate: round2(l.purchase_rate),
        notes: l.notes?.trim() || null,
      })),
      p_invoice_no: head.invoice_no.trim() || null,
      p_invoice_date: head.invoice_date || null,
      p_postage: totals.postage,
      p_cgst: totals.cgst,
      p_sgst: totals.sgst,
      p_notes: head.notes.trim() || null,
    })
    setSaving(false)
    if (error) { setErr(`Could not save this correction: ${error.message}`); return }
    onSaved({
      old_total: Number(data?.old_total ?? oldTotal),
      new_total: Number(data?.new_total ?? totals.grand),
      difference: Number(data?.difference ?? difference),
    })
  }

  return (
    <form onSubmit={save} className="mx-auto max-w-3xl space-y-5">
      <button type="button" onClick={onCancel}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-ink">
        <IconArrowLeft size={17} /> Back to the bill
      </button>

      <div className="rounded-lg border border-line bg-card p-5">
        <h2 className="text-xl font-bold">Edit purchase bill</h2>
        <p className="mt-1 text-sm text-muted">
          Make this match the supplier’s paper bill. Stock and{' '}
          {bill.supplier?.name || 'the supplier'}’s balance are corrected by the difference when you save.
        </p>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="Bill no." value={head.invoice_no} onChange={setHeadVal('invoice_no')}
                 placeholder="As printed on the supplier's bill" />
          <Field label="Bill date" type="date" value={head.invoice_date} onChange={setHeadVal('invoice_date')} />
        </div>

        {/* Supplier is fixed. Moving a bill between two suppliers is not an edit;
            it takes money off one party and puts it on another. */}
        <p className="mt-3 text-xs text-muted">
          Supplier: <span className="font-medium text-ink">{bill.supplier?.name || '—'}</span> — a bill can’t be
          moved to another supplier. Remove these lines and enter it under the right one.
        </p>
      </div>

      {/* Lines */}
      <div className="overflow-hidden rounded-lg border border-line bg-card">
        <div className="border-b border-line bg-paper-2 px-5 py-2.5 text-xs font-semibold uppercase tracking-wider text-muted">
          Items on this bill
        </div>
        <ul className="divide-y divide-line">
          {lines.map((l) => {
            const onHand = stock?.[l.item_id]
            return (
              <li key={l.key} className="px-5 py-4">
                <div className="flex items-start gap-3">
                  <PhotoThumb url={l.photo_url} size="h-12 w-12" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-ink">{l.name}</p>
                    <p className="text-xs text-muted">
                      {l.item_no && <span className="fig">{l.item_no}</span>}
                      {onHand && (
                        <>
                          {l.item_no && ' · '}
                          <span className="fig">{qty(onHand.quantity)}</span> in stock now
                        </>
                      )}
                      {!l.id && <> · <Badge tone="peacock">added</Badge></>}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => { setLines((ls) => ls.filter((x) => x.key !== l.key)); setErr('') }}
                    className="shrink-0 rounded p-1.5 text-muted hover:bg-dues/10 hover:text-dues"
                    title="Take this product off the bill"
                  >
                    <IconTrash size={18} />
                  </button>
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  <Field label="Quantity (pcs)" inputMode="decimal" value={l.quantity}
                         onChange={(e) => setLine(l.key, 'quantity', e.target.value)} />
                  <Field label="Cost rate" prefix={currency} inputMode="decimal" value={l.purchase_rate}
                         onChange={(e) => setLine(l.key, 'purchase_rate', e.target.value)} />
                  <div>
                    <p className="mb-1.5 text-sm font-medium text-ink">Line total</p>
                    <p className="fig py-2 text-lg font-semibold">{c(lineTotal(l))}</p>
                  </div>
                </div>
              </li>
            )
          })}
          {!lines.length && (
            <li className="px-5 py-8 text-center text-sm text-muted">
              Every product has been taken off this bill. Add one back, or press Cancel to leave the bill as it was.
            </li>
          )}
        </ul>

        <div className="border-t border-line px-5 py-3">
          {adding ? (
            <AddLine
              shopId={bill.shopId}
              supplierId={bill.supplierId}
              currency={currency}
              onCancel={() => setAdding(false)}
              onAdd={(item) => {
                setLines((ls) => [...ls, {
                  key: nextKey(), id: null, item_id: item.id, name: item.name,
                  item_no: item.item_no, photo_url: item.photo_url || null,
                  gst_rate: item.gst_rate ?? null,
                  quantity: '', purchase_rate: String(item.purchase_rate ?? ''), notes: '',
                }])
                setAdding(false); setErr('')
              }}
            />
          ) : (
            <Button variant="ghost" onClick={() => setAdding(true)}>
              <IconPlus size={18} /> Add product to this bill
            </Button>
          )}
        </div>
      </div>

      {/* Postage / GST */}
      <div className="rounded-lg border border-line bg-card p-5">
        <h3 className="font-semibold text-ink">Postage &amp; GST on this bill</h3>
        <p className="text-xs text-muted">
          Postage is pass-through and GST is claimable input credit — neither is part of a product’s cost.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <Field label="Postage / freight" prefix={currency} inputMode="decimal"
                 value={head.postage} onChange={setHeadVal('postage')} placeholder="0" />
          <Field label="CGST" prefix={currency} inputMode="decimal"
                 value={head.cgst} onChange={setHeadVal('cgst')} placeholder="0" />
          <Field label="SGST" prefix={currency} inputMode="decimal"
                 value={head.sgst} onChange={setHeadVal('sgst')} placeholder="0" />
        </div>
        {suggested && (
          <button
            type="button"
            onClick={() => setHead((h) => ({ ...h, cgst: String(suggested.cgst), sgst: String(suggested.sgst) }))}
            className="mt-3 text-xs font-medium text-peacock hover:underline"
          >
            Fill {c(suggested.cgst)} + {c(suggested.sgst)} from these products’ GST rates
          </button>
        )}
      </div>

      {/* What saving will do */}
      <div className="space-y-1 rounded-lg border border-line bg-paper-2 px-5 py-4 text-sm">
        <Charge label="Goods total" value={c(totals.goods)} />
        {totals.postage > 0 && <Charge label="Postage / freight" value={c(totals.postage)} />}
        {totals.cgst > 0 && <Charge label="CGST" value={c(totals.cgst)} />}
        {totals.sgst > 0 && <Charge label="SGST" value={c(totals.sgst)} />}
        <div className="flex items-baseline justify-between gap-3 border-t border-line pt-1.5 font-semibold">
          <span>New bill total</span>
          <span className="fig">{c(totals.grand)}</span>
        </div>
        <div className="flex items-baseline justify-between gap-3 text-muted">
          <span>Was</span>
          <span className="fig">{c(oldTotal)}</span>
        </div>
        <p className="pt-2 text-xs text-ink">
          {difference === 0
            ? 'The total is unchanged, so nothing moves on the supplier’s balance.'
            : <>
                <span className="fig font-semibold">{c(Math.abs(difference))}</span>{' '}
                {difference > 0 ? 'will be added to' : 'will come off'}{' '}
                {bill.supplier?.name || 'the supplier'}’s balance, as one correction entry in their ledger.
              </>}
        </p>
      </div>

      {costChanges.length > 0 && (
        <div className="rounded-lg bg-saffron/10 px-5 py-4 text-xs text-ink">
          <p className="font-semibold">This also changes what these products cost you:</p>
          <ul className="mt-1 space-y-0.5">
            {costChanges.map((ch) => (
              <li key={ch.id}>
                {ch.name}: <span className="fig">{c(ch.from)}</span> → <span className="fig">{c(ch.to)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-muted">
            Profit on future sales uses the new cost. Sales already made keep the cost they were booked with.
          </p>
        </div>
      )}

      {shortfalls.length > 0 && (
        <div className="flex gap-2 rounded-lg bg-dues/10 px-5 py-4 text-sm text-dues">
          <IconAlertTriangle size={18} className="mt-0.5 shrink-0" />
          <p>
            Not enough stock for this change:{' '}
            {shortfalls.map((s) => `${s.name} (short by ${qty(s.short)} pcs)`).join(', ')}. Those pcs have
            already been sold. Fix: put the quantity back up, or leave the line on the bill.
          </p>
        </div>
      )}

      {err && <p className="rounded-lg bg-dues/10 px-4 py-3 text-sm text-dues">{err}</p>}

      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={saving || !lines.length || shortfalls.length > 0}>
          {saving ? <Spinner /> : <IconDeviceFloppy size={18} />} Save corrections
        </Button>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  )
}

function lineTotal(l) {
  return round2(Number(l.quantity || 0) * Number(l.purchase_rate || 0))
}

// Pick a product to add to the bill. Only real catalogue items: a bill correction
// is not the place to create a product — that is Purchase Entry's job, where the
// full catalogue form lives.
function AddLine({ shopId, supplierId, currency, onAdd, onCancel }) {
  const [search, setSearch] = useState('')
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [onlyThisSupplier, setOnlyThisSupplier] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    // Make-to-Order items hold no stock, so they are never bought on a bill.
    let q = supabase
      .from('items')
      .select('id, item_no, name, company_no, quantity, purchase_rate, low_stock_threshold, photo_url, gst_rate, discontinued')
      .eq('shop_id', shopId)
      .eq('made_to_order', false)
      .order('name')
      .limit(50)
    if (onlyThisSupplier && supplierId) q = q.eq('supplier_id', supplierId)
    const term = search.trim()
    if (term) q = q.or(`name.ilike.%${term}%,item_no.ilike.%${term}%,company_no.ilike.%${term}%`)
    q.then(({ data }) => { if (!cancelled) { setItems(data || []); setLoading(false) } })
    return () => { cancelled = true }
  }, [search, shopId, supplierId, onlyThisSupplier])

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-ink">Which product was missed off this bill?</p>
        <button type="button" onClick={onCancel} className="text-muted hover:text-ink"><IconX size={18} /></button>
      </div>

      <Field label="Find the product" placeholder="Search by name, item no. or company no."
             value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />

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
            No matching products. Uncheck the supplier filter, or add the product from Purchase Entry first.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {items.map((it) => (
              <li key={it.id}>
                <button type="button" onClick={() => onAdd(it)}
                        className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-paper-2">
                  <span className="min-w-0">
                    <span className="font-medium">{it.name}</span>
                    {it.discontinued && <Badge tone="dues">discontinued</Badge>}
                    <span className="fig block text-xs text-muted">
                      {it.item_no}{it.company_no ? ` · ${it.company_no}` : ''} · cost{' '}
                      {money(it.purchase_rate).replace('₹', currency)}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2 text-sm text-muted">
                    <span className="fig">{qty(it.quantity)}</span>
                    <StockBadge quantity={it.quantity} threshold={it.low_stock_threshold} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

// Record the postage / CGST / SGST that a bill was entered without. INSERT only:
// the 036 trigger fires on insert and the ledger is append-only (Golden Rule #9),
// so once these are booked they are history — this form disappears and the
// figures show read-only. Correcting a wrong figure is a Payment Out, not an edit.
function BackfillCharges({ bill, currency, onSaved }) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ postage: '', cgst: '', sgst: '' })
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const set = (k) => (e) => { setForm((f) => ({ ...f, [k]: e.target.value })); setErr('') }

  const totals = purchaseBillTotals({
    goods: bill.goods, postage: form.postage, cgst: form.cgst, sgst: form.sgst,
  })
  const added = round2(totals.postage + totals.tax)

  // Same suggestion Purchase Entry offers: the tax these products' own GST slabs
  // (migration 034) imply. A hint only — the owner types what the paper bill says.
  const suggested = suggestPurchaseGst(bill.lines.map((l) => ({
    amount: Number(l.total_cost || 0), rate: l.item?.gst_rate,
  })))

  async function save(e) {
    e.preventDefault()
    if (added <= 0) { setErr('Enter postage, CGST or SGST first — there is nothing to record yet.'); return }
    setSaving(true); setErr('')
    const { error } = await supabase.from('purchase_bills').insert({
      shop_id: bill.shopId,
      supplier_id: bill.supplierId,
      purchase_group_id: bill.group,
      goods_total: totals.goods,
      postage: totals.postage,
      cgst_amount: totals.cgst,
      sgst_amount: totals.sgst,
      grand_total: totals.grand,
    })
    setSaving(false)
    if (error) { setErr(`Could not record these charges: ${error.message}`); return }
    onSaved()
  }

  const c = (n) => money(n).replace('₹', currency)

  if (!open) {
    return (
      <div className="no-print flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed border-line bg-card px-5 py-4">
        <p className="text-sm text-muted">
          Did this bill have postage or GST? It was never recorded, so the total above is goods only.
        </p>
        <Button variant="ghost" onClick={() => setOpen(true)}>
          <IconPlus size={18} /> Add postage / GST
        </Button>
      </div>
    )
  }

  return (
    <form onSubmit={save} className="no-print space-y-4 rounded-lg border border-line bg-card p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-ink">Add postage / GST to this bill</h3>
          <p className="text-xs text-muted">
            Type what the supplier's paper bill says. This is recorded once and can't be edited afterwards.
          </p>
        </div>
        <button type="button" onClick={() => setOpen(false)} className="shrink-0 text-muted hover:text-ink">
          <IconX size={18} />
        </button>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Postage / freight" prefix={currency} inputMode="decimal"
               value={form.postage} onChange={set('postage')} placeholder="0" />
        <Field label="CGST" prefix={currency} inputMode="decimal"
               value={form.cgst} onChange={set('cgst')} placeholder="0" />
        <Field label="SGST" prefix={currency} inputMode="decimal"
               value={form.sgst} onChange={set('sgst')} placeholder="0" />
      </div>

      {suggested && (
        <button
          type="button"
          onClick={() => setForm((f) => ({ ...f, cgst: String(suggested.cgst), sgst: String(suggested.sgst) }))}
          className="text-xs font-medium text-peacock hover:underline"
        >
          Fill {c(suggested.cgst)} + {c(suggested.sgst)} from these products' GST rates
        </button>
      )}

      <div className="space-y-1 rounded-lg bg-paper-2 px-4 py-3 text-sm">
        <Charge label="Goods (already recorded)" value={c(totals.goods)} />
        {totals.postage > 0 && <Charge label="Postage / freight" value={c(totals.postage)} />}
        {totals.cgst > 0 && <Charge label="CGST" value={c(totals.cgst)} />}
        {totals.sgst > 0 && <Charge label="SGST" value={c(totals.sgst)} />}
        <div className="flex justify-between gap-3 border-t border-line pt-1.5 font-semibold">
          <span>New bill total</span>
          <span className="fig">{c(totals.grand)}</span>
        </div>
      </div>

      <p className="rounded-lg bg-saffron/10 px-4 py-3 text-xs text-ink">
        Saving adds <span className="fig font-semibold">{c(added)}</span> to{' '}
        {bill.supplier?.name || 'this supplier'}'s balance and writes one ledger entry —
        the same as if it had been entered with the bill. Postage stays out of item cost,
        and the GST stays claimable input credit.
      </p>

      {err && <p className="rounded-lg bg-dues/10 px-4 py-3 text-sm text-dues">{err}</p>}

      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={saving || added <= 0}>
          {saving ? <Spinner /> : <IconDeviceFloppy size={18} />} Record these charges
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </form>
  )
}

function Charge({ label, value, hint }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-muted">
        {label}
        {hint && <span className="ml-2 text-xs">{hint}</span>}
      </span>
      <span className="fig">{value}</span>
    </div>
  )
}

function Empty({ children }) {
  return <div className="mx-auto max-w-md rounded-lg border border-dashed border-line p-10 text-center text-muted">{children}</div>
}
