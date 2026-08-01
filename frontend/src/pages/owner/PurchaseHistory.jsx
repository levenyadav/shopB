import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { IconSearch, IconInbox, IconCoin, IconFileSpreadsheet, IconChevronDown, IconChevronRight, IconTag, IconFileInvoice } from '@tabler/icons-react'
import { supabase } from '../../lib/supabase'
import { useShop } from '../../context/ShopContext'
import { money, qty, dateTime, dateShort } from '../../lib/format'
import { toCsv, downloadText } from '../../lib/csv'
import { toInputDate, startOfWeek, startOfMonth } from '../../lib/dates'
import { Badge, Spinner, PhotoThumb, Button } from '../../components/ui'

// SPEC §6.1 / §6.7.1 — Purchase history (owner only). Every purchase bill is
// one or more `purchases` rows (migration 033 ties a multi-line supplier bill
// together with a shared purchase_group_id; legacy rows are bills of one). This
// is a read-only book of what was bought — stock and supplier balances were
// already moved by the trigger (Golden Rule #10).
//
// Bills are grouped by purchase_group_id so a 12-line supplier bill reads as ONE
// card, and each card expands to its lines. Filters: search, supplier, date.
// One row per purchase line. The last four are bill-level (migration 036), so
// they are written only on a bill's FIRST line and left blank on the rest —
// otherwise summing the column would count one bill's postage many times.
const CSV_COLUMNS = [
  'Bill No', 'Bill Date', 'Supplier', 'Phone', 'Item No', 'Item',
  'Quantity', 'Rate', 'Amount',
  'Postage', 'CGST', 'SGST', 'Bill Total',
]

// Quick date ranges. 'all' clears the range; the rest run up to today.
const RANGES = [
  { key: 'all', label: 'All time' },
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'This week' },
  { key: 'month', label: 'This month' },
]

// Sortable local timestamp for the spreadsheet — `dateTime` is for humans on
// screen, this is what a spreadsheet can order and filter by.
function csvDateTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export default function PurchaseHistory() {
  const { currency } = useShop()
  const [purchases, setPurchases] = useState(null)
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')
  const [supplierId, setSupplierId] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [menu, setMenu] = useState(false)
  const [open, setOpen] = useState(new Set())

  // Quick ranges fill the From/To boxes rather than holding a state of their own,
  // so the two never disagree and typing a custom range simply lands on "Custom".
  function applyRange(key) {
    const today = toInputDate(new Date())
    if (key === 'all')   { setFrom(''); setTo(''); return }
    if (key === 'today') { setFrom(today); setTo(today); return }
    if (key === 'week')  { setFrom(toInputDate(startOfWeek())); setTo(today); return }
    if (key === 'month') { setFrom(toInputDate(startOfMonth())); setTo(today); return }
  }

  // Which pill is lit — derived from From/To, never stored.
  const activeRange = useMemo(() => {
    if (!from && !to) return 'all'
    const today = toInputDate(new Date())
    if (to !== today) return ''
    if (from === today) return 'today'
    if (from === toInputDate(startOfWeek())) return 'week'
    if (from === toInputDate(startOfMonth())) return 'month'
    return ''
  }, [from, to])

  async function load() {
    setErr('')
    // Postage / GST live in their own table (migration 036) and are asked for
    // separately, because migrations are applied by hand and the app can run one
    // ahead of the database — a missing table must cost the charges line, not the
    // whole page.
    // A failure here must not be silent: without these rows every bill totals to
    // goods only, and a wrong total that looks right is worse than an error.
    const charges = new Map()
    const { data: billRows, error: chargesErr } = await supabase
      .from('purchase_bills')
      .select('purchase_group_id, postage, cgst_amount, sgst_amount, grand_total')
    for (const c of billRows ?? []) charges.set(c.purchase_group_id, c)
    if (chargesErr) {
      setErr(`Postage and GST could not be read, so bill totals below are goods only. `
           + `Fix: run migration 036 on the database. (${chargesErr.message})`)
    }

    const { data, error } = await supabase
      .from('purchases')
      .select(
        'id, quantity, purchase_rate, total_cost, notes, created_at, ' +
          'invoice_no, invoice_date, purchase_group_id, supplier_id, item_no, item_name, ' +
          'item:items(name, item_no, photo_url), ' +
          'supplier:suppliers(id, name, phone), ' +
          'entered_by:profiles(full_name)',
      )
      .order('created_at', { ascending: false })
    if (error) { setErr(error.message); return }
    setPurchases((data ?? []).map((p) => ({ ...p, charges: charges.get(p.purchase_group_id) || null })))
  }
  useEffect(() => { load() }, [])

  // Group the rows into bills: every row sharing a purchase_group_id is one
  // supplier bill; legacy rows (no group) are bills of one.
  const bills = useMemo(() => {
    if (!purchases) return null
    const map = new Map()
    for (const p of purchases) {
      const key = p.purchase_group_id || p.id
      let b = map.get(key)
      if (!b) {
        b = {
          key,
          supplierId: p.supplier_id,
          supplier: p.supplier,
          invoice_no: p.invoice_no || '',
          invoice_date: p.invoice_date,
          createdAt: p.created_at,
          enteredBy: p.entered_by?.full_name,
          charges: p.charges,
          lines: [],
        }
        map.set(key, b)
      }
      b.lines.push(p)
      if (p.created_at < b.createdAt) b.createdAt = p.created_at
      if (p.invoice_date && (!b.invoice_date || p.invoice_date < b.invoice_date)) b.invoice_date = p.invoice_date
      if (!b.invoice_no && p.invoice_no) b.invoice_no = p.invoice_no
    }
    const list = [...map.values()]
    for (const b of list) {
      b.qty = b.lines.reduce((a, l) => a + Number(l.quantity || 0), 0)
      // Goods is what the lines cost; postage and the supplier's GST (036) sit
      // on top of it. `total` stays the goods figure so the per-line sums still
      // tie out, and `grand` is what the supplier was actually owed.
      b.total = b.lines.reduce((a, l) => a + Number(l.total_cost || 0), 0)
      b.postage = Number(b.charges?.postage || 0)
      b.tax = Number(b.charges?.cgst_amount || 0) + Number(b.charges?.sgst_amount || 0)
      b.grand = b.total + b.postage + b.tax
    }
    return list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  }, [purchases])

  // Suppliers seen in the loaded bills — feeds the dropdown.
  const supplierOptions = useMemo(() => {
    const map = new Map()
    for (const b of bills ?? []) {
      if (b.supplierId && !map.has(b.supplierId)) map.set(b.supplierId, b.supplier)
    }
    return [...map.values()]
  }, [bills])

  const filtered = useMemo(() => {
    if (!bills) return []
    const needle = q.trim().toLowerCase()
    // Inclusive day bounds — `to` covers the whole selected day.
    const fromTs = from ? new Date(`${from}T00:00:00`).getTime() : null
    const toTs = to ? new Date(`${to}T23:59:59.999`).getTime() : null
    return bills.filter((b) => {
      if (supplierId && b.supplierId !== supplierId) return false
      if (fromTs || toTs) {
        const t = new Date(b.createdAt).getTime()
        if (fromTs && t < fromTs) return false
        if (toTs && t > toTs) return false
      }
      if (needle) {
        const hay = `${b.invoice_no} ${b.supplier?.name || ''} ${b.lines
          .map((l) => l.item_name || l.item?.name || '')
          .join(' ')}`.toLowerCase()
        if (!hay.includes(needle)) return false
      }
      return true
    })
  }, [bills, q, supplierId, from, to])

  const totals = useMemo(() => filtered.reduce(
    (a, b) => {
      a.bills += 1
      a.lines += b.lines.length
      a.amount += b.total
      a.postage += b.postage
      a.cgst += Number(b.charges?.cgst_amount || 0)
      a.sgst += Number(b.charges?.sgst_amount || 0)
      a.tax += b.tax
      a.grand += b.grand
      return a
    },
    { bills: 0, lines: 0, amount: 0, postage: 0, cgst: 0, sgst: 0, tax: 0, grand: 0 },
  ), [filtered])

  // Export exactly what the owner is looking at — one row per purchase line,
  // grouped together by Bill No — so the spreadsheet sums to the totals on
  // screen. Money columns are plain numbers so Excel/Sheets can add them.
  function exportCsv() {
    if (!filtered.length) {
      setErr('Nothing to export — widen the filters and try again.')
      return
    }
    setErr('')
    const rows = []
    for (const b of filtered) {
      b.lines.forEach((l, i) => {
        rows.push({
          'Bill No': b.invoice_no || (b.lines.length > 1 ? 'Batch' : ''),
          'Bill Date': b.invoice_date ? b.invoice_date : csvDateTime(b.createdAt).slice(0, 10),
          'Supplier': b.supplier?.name || '',
          'Phone': b.supplier?.phone || '',
          'Item No': l.item_no || l.item?.item_no || '',
          'Item': l.item_name || l.item?.name || '',
          'Quantity': Number(l.quantity || 0),
          'Rate': Number(l.purchase_rate || 0),
          'Amount': Number(l.total_cost || 0),
          // Bill-level, so only against the first line of the bill.
          'Postage': i === 0 ? b.postage : '',
          'CGST': i === 0 ? Number(b.charges?.cgst_amount || 0) : '',
          'SGST': i === 0 ? Number(b.charges?.sgst_amount || 0) : '',
          'Bill Total': i === 0 ? b.grand : '',
        })
      })
    }
    rows.push({
      'Bill No': 'TOTAL', 'Item': `${totals.bills} bills, ${totals.lines} lines`,
      'Amount': totals.amount,
      'Postage': totals.postage,
      'CGST': totals.cgst,
      'SGST': totals.sgst,
      'Bill Total': totals.grand,
    })
    const span = from || to ? `${from || 'start'}_to_${to || toInputDate(new Date())}` : toInputDate(new Date())
    downloadText(`purchases-${span}.csv`, toCsv(CSV_COLUMNS, rows))
  }

  function toggleBill(key) {
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <div className="space-y-5">
      {/* Totals for the current filter (SPEC §3.2 — every number has a label) */}
      <div className={`grid gap-3 sm:grid-cols-2 ${totals.tax > 0 ? 'lg:grid-cols-4' : 'lg:grid-cols-3'}`}>
        <Stat label="Bills shown" value={<span className="fig">{qty(totals.bills)}</span>} />
        <Stat label="Items bought" value={<span className="fig">{qty(totals.lines)}</span>} />
        <Stat
          label="Total paid to suppliers"
          value={<span className="fig text-profit">{money(totals.grand).replace('₹', currency)}</span>}
          hint={totals.postage > 0 || totals.tax > 0
            ? `Goods ${money(totals.amount).replace('₹', currency)}${totals.postage > 0 ? ` · postage ${money(totals.postage).replace('₹', currency)}` : ''}${totals.tax > 0 ? ` · GST ${money(totals.tax).replace('₹', currency)}` : ''}`
            : null}
          accent
        />
        {totals.tax > 0 && (
          <Stat
            label="GST paid (input credit)"
            value={<span className="fig">{money(totals.tax).replace('₹', currency)}</span>}
            hint="Claimable back — not part of product cost"
          />
        )}
      </div>

      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted">
          {filtered.length === 0
            ? 'Nothing to export yet.'
            : `Download the ${qty(filtered.length)} bill${filtered.length === 1 ? '' : 's'} shown below as a spreadsheet.`}
        </p>
        <div className="relative shrink-0">
          <Button variant="ghost" onClick={() => setMenu((m) => !m)} disabled={filtered.length === 0}>
            <IconFileSpreadsheet size={18} /> Export CSV
            <IconChevronDown size={16} className={`transition ${menu ? 'rotate-180' : ''}`} />
          </Button>
          {menu && (
            <>
              {/* Click anywhere else to dismiss. */}
              <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} />
              <div className="absolute right-0 z-20 mt-1 w-56 overflow-hidden rounded-lg border border-line bg-card shadow-lg">
                <button
                  type="button" onClick={() => { setMenu(false); exportCsv() }}
                  className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-sm text-ink transition hover:bg-paper-2"
                >
                  All bills shown
                  <span className="fig text-xs text-muted">{qty(filtered.length)}</span>
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Filters: search + supplier + quick date ranges */}
      <div className="grid gap-3 rounded-lg border border-line bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="relative sm:col-span-2">
          <IconSearch size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search bill no., supplier or item…"
            className="w-full rounded-lg border border-line bg-card py-2.5 pl-9 pr-3 text-ink outline-none focus:border-peacock focus:ring-1 focus:ring-peacock"
          />
        </div>
        <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}
                className="rounded-lg border border-line bg-card px-3 py-2.5 text-ink outline-none focus:border-peacock focus:ring-1 focus:ring-peacock">
          <option value="">All suppliers</option>
          {supplierOptions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <div className="flex flex-wrap gap-1.5 sm:col-span-2 lg:col-span-2">
          {RANGES.map(({ key, label }) => (
            <button
              key={key} type="button" onClick={() => applyRange(key)}
              className={`rounded-full border px-3 py-1.5 text-sm font-medium transition ${
                activeRange === key ? 'border-peacock bg-peacock text-white' : 'border-line bg-card text-muted hover:text-ink'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm text-muted">
          <span className="shrink-0">From</span>
          <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)}
                 className="w-full rounded-lg border border-line bg-card px-3 py-2.5 text-ink outline-none focus:border-peacock focus:ring-1 focus:ring-peacock" />
        </label>
        <label className="flex items-center gap-2 text-sm text-muted">
          <span className="shrink-0">To</span>
          <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)}
                 className="w-full rounded-lg border border-line bg-card px-3 py-2.5 text-ink outline-none focus:border-peacock focus:ring-1 focus:ring-peacock" />
        </label>
      </div>

      {err && <p className="rounded-lg bg-dues/10 px-4 py-3 text-sm text-dues">{err}</p>}

      {purchases === null ? (
        <div className="grid place-items-center py-16 text-muted"><Spinner /></div>
      ) : filtered.length === 0 ? (
        <div className="grid place-items-center gap-3 rounded-lg border border-dashed border-line py-16 text-center text-muted">
          <IconInbox size={38} stroke={1.3} />
          <p>{purchases.length === 0 ? 'No purchases yet. Enter a Purchase Entry to record the first bill.' : 'No bills match these filters.'}</p>
        </div>
      ) : (
        <ul className="space-y-2.5">
          {filtered.map((b) => (
            <li key={b.key}>
              <BillCard
                bill={b}
                expanded={open.has(b.key)}
                onToggle={() => toggleBill(b.key)}
                currency={currency}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// One supplier bill. Header shows who/what/when/how much; the body expands to
// the item lines. The supplier name links to their party ledger.
function BillCard({ bill, expanded, onToggle, currency }) {
  const badge = bill.invoice_no
    ? <Badge tone="peacock"><IconTag size={13} className="inline -mt-0.5" /> {bill.invoice_no}</Badge>
    : <Badge tone="muted">No bill no.</Badge>

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-card">
      <button
        type="button" onClick={onToggle}
        className="flex w-full items-center gap-4 px-4 py-3 text-left transition hover:bg-paper-2"
      >
        <IconChevronRight size={18} className={`shrink-0 text-muted transition-transform ${expanded ? 'rotate-90' : ''}`} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2">
            {badge}
            <Link
              to={bill.supplierId ? `/owner/parties/supplier/${bill.supplierId}` : '#'}
              onClick={(e) => e.stopPropagation()}
              className="truncate font-medium text-ink hover:text-peacock"
            >
              {bill.supplier?.name || 'Supplier'}
            </Link>
          </p>
          <p className="mt-0.5 text-xs text-muted">
            {bill.lines.length} item{bill.lines.length === 1 ? '' : 's'} ·{' '}
            <span className="fig">{qty(bill.qty)}</span> pcs
            <span className="ml-2">{bill.invoice_date ? `Bill date ${dateShort(bill.invoice_date)}` : dateTime(bill.createdAt)}</span>
            {bill.enteredBy && <span className="ml-2">by {bill.enteredBy}</span>}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="fig font-semibold">{money(bill.grand).replace('₹', currency)}</p>
          {(bill.postage > 0 || bill.tax > 0) && (
            <p className="text-xs text-muted">goods {money(bill.total).replace('₹', currency)}</p>
          )}
        </div>
      </button>

      {expanded && (
        <ul className="divide-y divide-line border-t border-line">
          {bill.lines.map((l) => (
            <li key={l.id} className="flex items-center gap-3 px-4 py-2.5">
              <PhotoThumb url={l.item?.photo_url} size="h-10 w-10" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink">{l.item_name || l.item?.name || 'Item'}</p>
                <p className="text-xs text-muted">
                  {(l.item_no || l.item?.item_no) && <span className="fig">{l.item_no || l.item?.item_no} · </span>}
                  <span className="fig">{qty(l.quantity)}</span> ×{' '}
                  <span className="fig">{money(l.purchase_rate).replace('₹', currency)}</span>
                </p>
              </div>
              <p className="fig shrink-0 text-sm font-semibold">{money(l.total_cost).replace('₹', currency)}</p>
            </li>
          ))}

          {/* Postage and the supplier's GST (036) — on the bill, never in the
              product cost above. */}
          {(bill.postage > 0 || bill.tax > 0) && (
            <li className="space-y-1 bg-paper-2 px-4 py-2.5 text-sm">
              <ChargeRow label="Goods" value={money(bill.total).replace('₹', currency)} />
              {bill.postage > 0 && <ChargeRow label="Postage / freight" value={money(bill.postage).replace('₹', currency)} />}
              {Number(bill.charges?.cgst_amount) > 0 && <ChargeRow label="CGST" value={money(bill.charges.cgst_amount).replace('₹', currency)} />}
              {Number(bill.charges?.sgst_amount) > 0 && <ChargeRow label="SGST" value={money(bill.charges.sgst_amount).replace('₹', currency)} />}
              <div className="flex justify-between gap-3 border-t border-line pt-1 font-semibold">
                <span>Bill total</span>
                <span className="fig">{money(bill.grand).replace('₹', currency)}</span>
              </div>
            </li>
          )}

          {/* The full bill on its own page — printable, and the same page the
              supplier's ledger entry opens. Any line id resolves the bill. */}
          <li className="px-4 py-2.5">
            <Link
              to={`/owner/purchases/${bill.lines[0].id}`}
              className="inline-flex items-center gap-1 text-sm font-medium text-peacock hover:underline"
            >
              <IconFileInvoice size={16} /> Open full bill
            </Link>
          </li>
        </ul>
      )}
    </div>
  )
}

function ChargeRow({ label, value }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted">{label}</span>
      <span className="fig">{value}</span>
    </div>
  )
}

function Stat({ label, value, hint, accent }) {
  return (
    <div className={`rounded-lg border bg-card px-5 py-3 ${accent ? 'border-profit/30' : 'border-line'}`}>
      <p className="flex items-center gap-1.5 text-xs text-muted">
        {accent && <IconCoin size={14} className="text-profit" />}{label}
      </p>
      <p className="mt-0.5 text-2xl font-bold">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </div>
  )
}
