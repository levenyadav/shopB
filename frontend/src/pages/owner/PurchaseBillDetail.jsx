import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  IconArrowLeft, IconPrinter, IconEye, IconTag, IconTruck, IconUser, IconPhone, IconMapPin,
  IconPlus, IconX, IconDeviceFloppy,
} from '@tabler/icons-react'
import { supabase } from '../../lib/supabase'
import { useShop } from '../../context/ShopContext'
import { money, qty, dateTime, dateShort } from '../../lib/format'
import { round2, purchaseBillTotals, suggestPurchaseGst } from '../../lib/helpers'
import { buildPurchaseBillModel, viewPurchaseBill, printPurchaseBill } from '../../lib/purchaseBillTemplate'
import { Badge, Spinner, Button, PhotoThumb, Field } from '../../components/ui'

// SPEC §6.1 / §6.7.1 — one supplier bill, in full. Reached from the supplier's
// ledger (the `purchase` entry links straight here) and from Purchase History.
//
// The route id is any `purchases` row id, because that is exactly what the
// ledger stores: migration 033 points a bill's ledger row at the FIRST LINE of
// the bill, and every sibling line shares its purchase_group_id. Legacy rows
// predate grouping and are simply bills of one, so they land here too.
//
// Read-only: stock and the supplier balance were moved by triggers when the bill
// was entered (Golden Rules #9, #10). Nothing on this page writes.
export default function PurchaseBillDetail() {
  const { id } = useParams()
  const { shop, currency } = useShop()
  const [bill, setBill] = useState(null)
  const [err, setErr] = useState('')
  const [missing, setMissing] = useState(false)
  const [reload, setReload] = useState(0)

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
      let lineQuery = supabase
        .from('purchases')
        .select(
          'id, shop_id, supplier_id, quantity, purchase_rate, total_cost, notes, created_at, ' +
            'invoice_no, invoice_date, purchase_group_id, ' +
            'item_no, item_name, ' +
            'item:items(id, name, item_no, photo_url, hsn_sac, gst_rate), ' +
            'supplier:suppliers(id, name, phone, contact_person, address), ' +
            'entered_by:profiles(full_name)',
        )
        .order('created_at', { ascending: true })
      lineQuery = group ? lineQuery.eq('purchase_group_id', group) : lineQuery.eq('id', id)

      const { data: lines, error: lineErr } = await lineQuery
      if (!active) return
      if (lineErr) { setErr(lineErr.message); return }
      if (!lines?.length) { setMissing(true); return }

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

      const first = lines[0]
      const goods = lines.reduce((a, l) => a + Number(l.total_cost || 0), 0)
      const postage = Number(charges?.postage || 0)
      const cgst = Number(charges?.cgst_amount || 0)
      const sgst = Number(charges?.sgst_amount || 0)
      setBill({
        lines,
        group,
        shopId: first.shop_id,
        supplierId: first.supplier_id,
        supplier: first.supplier,
        invoice_no: lines.find((l) => l.invoice_no)?.invoice_no || '',
        invoice_date: lines.find((l) => l.invoice_date)?.invoice_date || null,
        createdAt: first.created_at,
        enteredBy: first.entered_by?.full_name,
        notes: charges?.notes || lines.find((l) => l.notes)?.notes || '',
        pcs: lines.reduce((a, l) => a + Number(l.quantity || 0), 0),
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

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <Link to="/owner/purchases" className="no-print inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-ink">
        <IconArrowLeft size={17} /> Purchase history
      </Link>

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

      {bill.notes && (
        <div className="rounded-lg border border-line bg-card p-4 text-sm">
          <p className="text-xs text-muted">Note</p>
          <p className="text-ink">{bill.notes}</p>
        </div>
      )}

      <div className="no-print flex flex-wrap items-center gap-3">
        <Button onClick={() => viewPurchaseBill(doc)}>
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

      {err && bill && <p className="no-print rounded-lg bg-dues/10 px-4 py-3 text-sm text-dues">{err}</p>}
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
