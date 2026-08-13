import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  IconArrowLeft, IconPrinter, IconEye, IconTag, IconTruck, IconUser, IconPhone, IconMapPin,
  IconPlus, IconX, IconDeviceFloppy, IconPencil, IconAlertTriangle, IconPackage,
  IconSearch, IconSparkles,
} from '@tabler/icons-react'
import { supabase } from '../../lib/supabase'
import { useShop } from '../../context/ShopContext'
import { useAuth } from '../../context/AuthContext'
import { money, qty, dateTime, dateShort } from '../../lib/format'
import { round2, purchaseBillTotals, suggestPurchaseGst } from '../../lib/helpers'
import { buildPurchaseBillModel, viewPurchaseBill, printPurchaseBill } from '../../lib/purchaseBillTemplate'
import { Badge, Spinner, Button, PhotoThumb, Field } from '../../components/ui'
// The same bill-building UI Purchase Entry uses, so correcting a bill offers
// exactly the options entering one does.
import {
  BLANK_NEW, lineCost, LinesTable, LineEditor, BillCharges,
  Section, Row, createProductFromLine,
} from '../../components/purchase'
import { stockShortfalls, costRateChanges, billEditProblem } from '../../lib/purchaseEdit'

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
        'item:items(id, name, item_no, photo_url, hsn_sac, gst_rate, ' +
          'quantity, purchase_rate, low_stock_threshold), ' +
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
      {/* Only where a bill cannot be corrected outright: once 039 is on the
          database, Edit bill does this and more, and two buttons for one job
          would break "one clear primary action" (SPEC §3). */}
      {!hasCharges && bill.group && !bill.chargesErr && !bill.editable && (
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
// Correcting a bill.
//
// This is Purchase Entry's bill screen, in edit clothes: the same line table,
// the same line editor in both its modes (restock an existing item / create a
// new product outright), the same postage + auto-GST block, the same totals.
// All of it comes from components/purchase, so the two screens offer the same
// options and can never drift apart.
//
// What differs is the save. Nothing is written until Save, and Save is ONE call
// to edit_purchase_bill (migration 039), which applies the whole correction in a
// single transaction: a half-corrected bill is impossible, and stock and balance
// moves stay where they belong — in triggers, not here.
//
// The screen refuses in advance what the database would refuse: an edit that
// takes an item below zero stock, because those pcs have already been sold. The
// database is still the one enforcing it (039), but the owner should see it
// while typing, not after pressing Save.
// ---------------------------------------------------------------------------
function BillEditor({ bill, currency, onCancel, onSaved }) {
  const c = (n) => money(n).replace('₹', currency)

  // A bill line becomes a Purchase Entry line, plus `rowId` — the purchases row
  // it came from. Lines added here have no rowId until the RPC creates them.
  const [lines, setLines] = useState(() =>
    bill.lines.map((l) => ({
      mode: 'existing',
      rowId: l.id,
      // A product deleted from the catalogue (migration 028 detaches it) keeps
      // its name so the bill still reads properly, but has no id — which is what
      // marks the line uneditable below.
      item: l.item
        ? { ...l.item, name: l.item.name || l.item_name, item_no: l.item.item_no || l.item_no }
        : { id: null, name: l.item_name || 'Deleted product', item_no: l.item_no || '' },
      quantity: String(l.quantity ?? ''),
      purchase_rate: String(l.purchase_rate ?? ''),
      notes: l.notes || '',
    })),
  )
  const [head, setHead] = useState({
    // Already a YYYY-MM-DD date (not a timestamp), which is exactly what a date
    // input wants — parsing it through Date would shift it a day in some zones.
    invoice_no: bill.invoice_no || '',
    invoice_date: bill.invoice_date ? String(bill.invoice_date).slice(0, 10) : '',
    postage: bill.postage ? String(bill.postage) : '',
    cgst: bill.cgst ? String(bill.cgst) : '',
    sgst: bill.sgst ? String(bill.sgst) : '',
  })
  const [editing, setEditing] = useState(null)   // { line, index } while the dialog is open
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const setHeadVal = (k) => (e) => { setHead((h) => ({ ...h, [k]: e.target.value })); setErr('') }

  function upsertLine(line) {
    setLines((ls) => {
      if (editing?.index == null) return [...ls, line]
      const next = [...ls]
      // Editing a line keeps the purchases row it belongs to, so the correction
      // updates that row instead of removing it and adding a different one.
      next[editing.index] = { ...line, rowId: ls[editing.index].rowId }
      return next
    })
    setEditing(null)
    setErr('')
  }

  const goods = round2(lines.reduce((sum, l) => sum + lineCost(l), 0))
  const totals = purchaseBillTotals({
    goods, postage: head.postage, cgst: head.cgst, sgst: head.sgst,
  })
  const oldTotal = round2(bill.grand)
  const difference = round2(totals.grand - oldTotal)

  // What is on the shelf right now, for every product this bill touches — both
  // the ones still on it and the ones being taken off.
  const onHand = useMemo(() => {
    const m = new Map()
    for (const l of bill.lines) if (l.item?.id) m.set(l.item.id, l.item)
    for (const l of lines) if (l.item?.id && !m.has(l.item.id)) m.set(l.item.id, l.item)
    return m
  }, [bill.lines, lines])

  // Net change per product across the whole edit, the cost rates this pushes
  // onto the catalogue, and everything that blocks a save — all pure rules,
  // tested in lib/purchaseEdit.test.mjs.
  const shortfalls = useMemo(
    () => stockShortfalls({ originalLines: bill.lines, lines, onHand }),
    [bill.lines, lines, onHand],
  )
  const costChanges = useMemo(() => costRateChanges(lines), [lines])

  function validate() {
    return billEditProblem({ lines, shortfalls, fmtQty: qty })
  }

  async function save(e) {
    e.preventDefault()
    const problem = validate()
    if (problem) { setErr(problem); return }
    setSaving(true); setErr('')

    const createdItems = []
    try {
      // A product added to the bill from scratch needs its catalogue row first,
      // with NO opening stock — the stock arrives through the purchase line the
      // RPC writes below (Golden Rule #1), exactly as in Purchase Entry.
      const payload = []
      for (const l of lines) {
        let item = l.item
        if (l.mode === 'new') {
          item = await createProductFromLine({
            shopId: bill.shopId, supplierId: bill.supplierId, line: l,
          })
          createdItems.push(item.item_no)
        }
        payload.push({
          id: l.rowId || null,
          item_id: item.id,
          quantity: round2(l.quantity),
          purchase_rate: round2(l.purchase_rate),
          notes: l.notes?.trim() || null,
        })
      }

      const { data, error } = await supabase.rpc('edit_purchase_bill', {
        p_bill_id: bill.lines[0].id,
        p_lines: payload,
        p_invoice_no: head.invoice_no.trim() || null,
        p_invoice_date: head.invoice_date || null,
        p_postage: totals.postage,
        p_cgst: totals.cgst,
        p_sgst: totals.sgst,
        p_notes: null,   // no bill-note field here; 039 keeps the existing note
      })
      if (error) {
        throw new Error(
          createdItems.length
            ? `New products (${createdItems.join(', ')}) were added to your catalogue, but the correction `
              + `was not saved: ${error.message}. They are sitting at 0 stock — the bill is unchanged.`
            : `Could not save this correction: ${error.message}`,
        )
      }

      onSaved({
        old_total: Number(data?.old_total ?? oldTotal),
        new_total: Number(data?.new_total ?? totals.grand),
        difference: Number(data?.difference ?? difference),
      })
    } catch (e2) {
      setErr(e2.message || 'Could not save this correction. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <button type="button" onClick={onCancel}
              className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-ink">
        <IconArrowLeft size={17} /> Back to the bill
      </button>

      <form onSubmit={save} className="space-y-6">
        {err && (
          <p className="rounded-lg border border-dues/30 bg-dues/10 px-4 py-3 text-sm text-dues">{err}</p>
        )}

        {/* ---- Bill header ---- */}
        <Section title="Supplier bill" hint="Make this match the supplier's paper bill.">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="mb-1.5 text-sm font-medium text-ink">Company / Supplier</p>
              <p className="rounded-lg border border-line bg-paper-2 px-4 py-2.5 font-medium">
                {bill.supplier?.name || '—'}
              </p>
              {/* Moving a bill between two suppliers takes money off one party
                  and puts it on another — two transactions, not an edit. */}
              <p className="mt-1.5 text-xs text-muted">
                A bill can’t be moved to another supplier. Remove these lines and enter it under the right one.
              </p>
            </div>
            <Field label="Bill date" type="date" value={head.invoice_date}
                   onChange={setHeadVal('invoice_date')} hint="The date printed on the bill" />
          </div>
          <Field label="Bill / Invoice No. (optional)" placeholder="e.g. 4521"
                 value={head.invoice_no} onChange={setHeadVal('invoice_no')}
                 hint="The supplier's own bill number — so you can find this purchase again" />
        </Section>

        {/* ---- Line items ---- */}
        <Section
          title="Products on this bill"
          hint="Change a quantity or cost rate, take a product off, or add one that was missed."
        >
          {lines.length === 0 ? (
            <div className="rounded-lg border-2 border-dashed border-line bg-paper-2 px-6 py-8 text-center">
              <IconPackage size={28} className="mx-auto text-muted" />
              <p className="mt-2 font-semibold">Every product has been taken off</p>
              <p className="mt-0.5 text-sm text-muted">
                Add one back, or press Cancel to leave the bill as it was.
              </p>
            </div>
          ) : (
            <LinesTable
              lines={lines}
              onEdit={(i) => setEditing({ line: lines[i], index: i })}
              onRemove={(i) => { setLines((ls) => ls.filter((_, idx) => idx !== i)); setErr('') }}
            />
          )}

          <div className="flex flex-wrap gap-3">
            <Button
              variant="ghost"
              onClick={() => setEditing({
                line: { mode: 'existing', item: null, quantity: '', purchase_rate: '', notes: '' },
                index: null,
              })}
            >
              <IconSearch size={18} /> Add existing item
            </Button>
            <Button variant="ghost" onClick={() => setEditing({ line: { ...BLANK_NEW }, index: null })}>
              <IconSparkles size={18} /> Add new product
            </Button>
          </div>
        </Section>

        {/* ---- Postage & tax (migration 036) ---- */}
        {lines.length > 0 && (
          <BillCharges
            lines={lines}
            value={{ postage: head.postage, cgst: head.cgst, sgst: head.sgst }}
            onChange={(v) => setHead((h) => ({ ...h, ...v }))}
          />
        )}

        {/* ---- What saving will do ---- */}
        <div className="rounded-lg border border-line bg-card p-5 sm:p-6">
          <dl className="space-y-1.5 text-sm">
            <Row label={`Goods (${lines.length} product${lines.length === 1 ? '' : 's'})`} value={c(totals.goods)} />
            {totals.postage > 0 && <Row label="Postage / freight" value={c(totals.postage)} />}
            {totals.cgst > 0 && <Row label="CGST" value={c(totals.cgst)} />}
            {totals.sgst > 0 && <Row label="SGST" value={c(totals.sgst)} />}
          </dl>
          <div className="mt-3 flex flex-wrap items-baseline justify-between gap-2 border-t border-line pt-3">
            <span className="font-semibold">New bill total</span>
            <span className="fig text-2xl font-bold text-dues">{c(totals.grand)}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-baseline justify-between gap-2 text-sm text-muted">
            <span>Was</span>
            <span className="fig">{c(oldTotal)}</span>
          </div>
          <p className="mt-2 text-sm">
            {difference === 0
              ? <span className="text-muted">The total is unchanged, so nothing moves on the supplier’s balance.</span>
              : <>
                  <span className="fig font-semibold">{c(Math.abs(difference))}</span>{' '}
                  {difference > 0 ? 'will be added to' : 'will come off'}{' '}
                  {bill.supplier?.name || 'this supplier'}’s balance due, as one correction entry in their ledger.
                </>}
          </p>
        </div>

        {costChanges.length > 0 && (
          <div className="rounded-lg bg-saffron/10 px-5 py-4 text-sm">
            <p className="font-semibold text-ink">This also changes what these products cost you:</p>
            <ul className="mt-1 space-y-0.5">
              {costChanges.map((ch) => (
                <li key={ch.id}>
                  {ch.name}: <span className="fig">{c(ch.from)}</span> → <span className="fig">{c(ch.to)}</span>
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-xs text-muted">
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

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={saving || !lines.length || shortfalls.length > 0} className="px-6">
            {saving ? <><Spinner /> Saving…</> : 'Save corrections'}
          </Button>
          <button type="button" onClick={onCancel} className="text-sm font-medium text-muted hover:text-ink">
            Cancel
          </button>
        </div>
      </form>

      {editing && (
        <LineEditor
          key={editing.index ?? 'new'}
          initial={editing.line}
          shopId={bill.shopId}
          supplierId={bill.supplierId}
          // A Make-to-Order product buys nothing, so it would add nothing to a
          // bill — there is no such thing as a listing-only correction.
          allowMadeToOrder={false}
          submitLabel={editing.index == null ? 'Add to bill' : 'Save line'}
          onClose={() => setEditing(null)}
          onSave={upsertLine}
        />
      )}
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
