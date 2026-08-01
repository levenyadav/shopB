import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  IconArrowLeft, IconPrinter, IconEye, IconTag, IconTruck, IconUser, IconPhone, IconMapPin,
} from '@tabler/icons-react'
import { supabase } from '../../lib/supabase'
import { useShop } from '../../context/ShopContext'
import { money, qty, dateTime, dateShort } from '../../lib/format'
import { buildPurchaseBillModel, viewPurchaseBill, printPurchaseBill } from '../../lib/purchaseBillTemplate'
import { Badge, Spinner, Button, PhotoThumb } from '../../components/ui'

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
          'id, quantity, purchase_rate, total_cost, notes, created_at, ' +
            'invoice_no, invoice_date, purchase_group_id, ' +
            'item_no, item_name, ' +
            'item:items(id, name, item_no, photo_url, hsn_sac), ' +
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
      let charges = null
      if (group) {
        const { data } = await supabase
          .from('purchase_bills')
          .select('postage, cgst_amount, sgst_amount, grand_total, notes')
          .eq('purchase_group_id', group).maybeSingle()
        charges = data || null
      }
      if (!active) return

      const first = lines[0]
      const goods = lines.reduce((a, l) => a + Number(l.total_cost || 0), 0)
      const postage = Number(charges?.postage || 0)
      const cgst = Number(charges?.cgst_amount || 0)
      const sgst = Number(charges?.sgst_amount || 0)
      setBill({
        lines,
        supplier: first.supplier,
        invoice_no: lines.find((l) => l.invoice_no)?.invoice_no || '',
        invoice_date: lines.find((l) => l.invoice_date)?.invoice_date || null,
        createdAt: first.created_at,
        enteredBy: first.entered_by?.full_name,
        notes: charges?.notes || lines.find((l) => l.notes)?.notes || '',
        pcs: lines.reduce((a, l) => a + Number(l.quantity || 0), 0),
        goods, postage, cgst, sgst,
        grand: goods + postage + cgst + sgst,
      })
    }
    load()
    return () => { active = false }
  }, [id])

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
          {!hasCharges && (
            <p className="pt-1 text-xs text-muted">No postage or GST recorded on this bill.</p>
          )}
        </div>
      </div>

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
