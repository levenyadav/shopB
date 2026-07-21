import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { IconSearch, IconInbox, IconCoin, IconFileSpreadsheet, IconChevronDown } from '@tabler/icons-react'
import { supabase } from '../../lib/supabase'
import { useShop } from '../../context/ShopContext'
import { money, qty, dateTime } from '../../lib/format'
import { toCsv, downloadText } from '../../lib/csv'
import { toInputDate } from '../../lib/dates'
import { Badge, Spinner, PhotoThumb, Button } from '../../components/ui'

// SPEC §6.5 / §10.4 — Sales list (owner only). Every approved order becomes a
// sale row (created by the approval insert in OrderDetail; stock/ledger handled
// by the trigger, Golden Rule #10). This is a read-only book of what sold, with
// the filters SPEC §6.5 calls for: date, buyer, payment type, category. Owner is
// the only role that sees profit (Golden Rule #3), so the totals show it here.
const PAYMENT_FILTERS = [
  ['', 'All'], ['cash', 'Cash'], ['upi', 'UPI'], ['udhaar', 'Udhaar'],
]

// Column order of the CSV export (see exportCsv below).
const CSV_COLUMNS = [
  'Invoice No', 'Series', 'Date', 'Item No', 'Item', 'Category', 'Buyer', 'Phone', 'Buyer Type', 'Source',
  'Quantity', 'Rate', 'Amount', 'Purchase Rate', 'Profit', 'Payment',
]

// Invoice numbering series (035) — customers and dealers run separate books.
const SERIES_LABEL = { customer: 'Customer', dealer: 'Dealer' }

// Sortable local timestamp for the spreadsheet — `dateTime` is for humans on
// screen, this is what a spreadsheet can order and filter by.
function csvDateTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// Buyer-facing payment label + tone for the row badge.
export const PAYMENT_META = {
  cash:   { label: 'Cash',   tone: 'profit' },
  upi:    { label: 'UPI',    tone: 'peacock' },
  udhaar: { label: 'Udhaar', tone: 'dues' },
}

export default function Sales() {
  const { currency, categories } = useShop()
  const [sales, setSales] = useState(null)
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')
  const [buyerType, setBuyerType] = useState('')
  const [payment, setPayment] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [invoiceNos, setInvoiceNos] = useState({ bySale: new Map(), byBill: new Map() })
  const [menu, setMenu] = useState(false)

  async function load() {
    setErr('')
    const { data, error } = await supabase
      .from('sales')
      .select(
        'id, quantity, rate_charged, amount, purchase_rate, profit, payment_type, buyer_type, ' +
          'category_id, source, bill_id, created_at, item_no, item_name, ' +
          'item:items(name, photo_url), ' +
          'buyer:profiles!sales_buyer_id_fkey(full_name, phone), ' +
          'category:categories(name)',
      )
      .order('created_at', { ascending: false })
    if (error) setErr(error.message)
    else setSales(data ?? [])

    // Invoice numbers live on the separate `invoices` row (016), linked by
    // sale_id for a shopfront sale and by bill_id for a counter bill — and
    // bill_id carries no FK, so this can't be a PostgREST embed. One extra read,
    // mapped by hand. A counter bill is invoiced once, so every line of that
    // bill shares its number.
    const { data: invs } = await supabase
      .from('invoices')
      .select('invoice_no, sale_id, bill_id, series')
    const bySale = new Map()
    const byBill = new Map()
    for (const inv of invs ?? []) {
      if (inv.sale_id) bySale.set(inv.sale_id, inv)
      if (inv.bill_id) byBill.set(inv.bill_id, inv)
    }
    setInvoiceNos({ bySale, byBill })
  }
  useEffect(() => { load() }, [])

  const invoiceFor = (s) =>
    invoiceNos.bySale.get(s.id) || (s.bill_id ? invoiceNos.byBill.get(s.bill_id) : null) || null
  const invoiceNoFor = (s) => invoiceFor(s)?.invoice_no || ''

  const filtered = useMemo(() => {
    if (!sales) return []
    const needle = q.trim().toLowerCase()
    // Inclusive day bounds — `to` covers the whole selected day.
    const fromTs = from ? new Date(`${from}T00:00:00`).getTime() : null
    const toTs = to ? new Date(`${to}T23:59:59.999`).getTime() : null
    return sales.filter((s) => {
      if (buyerType && s.buyer_type !== buyerType) return false
      if (payment && s.payment_type !== payment) return false
      if (categoryId && s.category_id !== categoryId) return false
      if (fromTs || toTs) {
        const t = new Date(s.created_at).getTime()
        if (fromTs && t < fromTs) return false
        if (toTs && t > toTs) return false
      }
      if (needle) {
        const hay = `${s.item?.name || s.item_name || ''} ${s.buyer?.full_name || ''} ${s.buyer?.phone || ''} ${invoiceNoFor(s)}`.toLowerCase()
        if (!hay.includes(needle)) return false
      }
      return true
    })
  }, [sales, q, buyerType, payment, categoryId, from, to, invoiceNos])

  // How many of the rows on screen belong to each book — shown on the export
  // menu so the owner knows what a choice will produce before clicking it.
  const counts = useMemo(() => ({
    customer: filtered.filter((s) => s.buyer_type === 'customer').length,
    dealer: filtered.filter((s) => s.buyer_type === 'dealer').length,
  }), [filtered])

  const totals = useMemo(() => filtered.reduce(
    (a, s) => {
      a.amount += Number(s.amount || 0)
      a.profit += Number(s.profit || 0)
      return a
    },
    { amount: 0, profit: 0 },
  ), [filtered])

  // Export exactly what the owner is looking at — the filtered rows, in the same
  // order — so the spreadsheet matches the totals on screen. Money columns are
  // plain numbers (no ₹, no thousands separator) so Excel/Sheets can sum them;
  // the date is sortable rather than pretty. purchase_rate/profit are owner-only
  // (Golden Rule #3/#4) and this page is owner-only, so they belong in the file.
  //
  // `scope` narrows it further without touching the screen: '' = everything
  // shown, 'customer' / 'dealer' = that book only. The two books are exported
  // and filed separately, so it must be possible to pull one without first
  // rearranging the page.
  function exportCsv(scope = '') {
    const picked = scope ? filtered.filter((s) => s.buyer_type === scope) : filtered
    if (!picked.length) {
      setErr(`No ${scope} sales in what you are looking at. Widen the filters and try again.`)
      return
    }
    setErr('')
    // Totals belong to the file, not the screen — a customer-only export must
    // add up to the customer rows inside it.
    const sums = picked.reduce(
      (a, s) => { a.amount += Number(s.amount || 0); a.profit += Number(s.profit || 0); return a },
      { amount: 0, profit: 0 },
    )
    const rows = picked.map((s) => ({
      'Invoice No': invoiceNoFor(s),
      // Which series the number was drawn from — not the same as Buyer Type. A
      // dealer sale from before the split legitimately carries a customer number.
      'Series': SERIES_LABEL[invoiceFor(s)?.series] || '',
      'Date': csvDateTime(s.created_at),
      'Item No': s.item_no || '',
      'Item': s.item?.name || s.item_name || '',
      'Category': s.category?.name || '',
      'Buyer': s.buyer?.full_name || '',
      'Phone': s.buyer?.phone || '',
      'Buyer Type': s.buyer_type || '',
      'Source': s.source === 'counter' ? 'Counter' : 'Shopfront',
      'Quantity': Number(s.quantity || 0),
      'Rate': Number(s.rate_charged || 0),
      'Amount': Number(s.amount || 0),
      'Purchase Rate': Number(s.purchase_rate || 0),
      'Profit': Number(s.profit || 0),
      'Payment': PAYMENT_META[s.payment_type]?.label || s.payment_type || '',
    }))
    // Totals row, so the file stands on its own when it is mailed to the CA.
    rows.push({
      'Invoice No': 'TOTAL', 'Item': `${picked.length} sales`,
      'Amount': sums.amount, 'Profit': sums.profit,
    })
    const span = from || to ? `${from || 'start'}_to_${to || toInputDate(new Date())}` : toInputDate(new Date())
    // Name the file after whichever book it holds — a dealer export and a
    // customer export must never be mistaken for each other once they are off
    // the screen. The explicit scope wins over the dropdown.
    const book = scope || buyerType
    downloadText(`sales-${book ? `${book}-` : ''}${span}.csv`, toCsv(CSV_COLUMNS, rows))
  }

  return (
    <div className="space-y-5">
      {/* Totals for the current filter (SPEC §3.2 — every number has a label) */}
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Sales shown" value={<span className="fig">{qty(filtered.length)}</span>} />
        <Stat label="Total amount" value={<span className="fig">{money(totals.amount).replace('₹', currency)}</span>} />
        <Stat label="Total profit" value={<span className="fig text-profit">{money(totals.profit).replace('₹', currency)}</span>} accent />
      </div>

      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted">
          {filtered.length === 0
            ? 'Nothing to export yet.'
            : `Download the ${qty(filtered.length)} sale${filtered.length === 1 ? '' : 's'} shown below — all of them, or one book on its own.`}
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
              <div className="absolute right-0 z-20 mt-1 w-64 overflow-hidden rounded-lg border border-line bg-card shadow-lg">
                <ExportChoice label="All sales shown" count={filtered.length}
                              onClick={() => { setMenu(false); exportCsv() }} />
                <ExportChoice label="Customer sales only" count={counts.customer}
                              onClick={() => { setMenu(false); exportCsv('customer') }} />
                <ExportChoice label="Dealer sales only" count={counts.dealer}
                              onClick={() => { setMenu(false); exportCsv('dealer') }} />
              </div>
            </>
          )}
        </div>
      </div>

      {/* Filters: search + buyer + category + date, payment as pills */}
      <div className="grid gap-3 rounded-lg border border-line bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="relative sm:col-span-2">
          <IconSearch size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search buyer, item or invoice no…"
            className="w-full rounded-lg border border-line bg-card py-2.5 pl-9 pr-3 text-ink outline-none focus:border-peacock focus:ring-1 focus:ring-peacock"
          />
        </div>
        <select value={buyerType} onChange={(e) => setBuyerType(e.target.value)}
                className="rounded-lg border border-line bg-card px-3 py-2.5 text-ink outline-none focus:border-peacock focus:ring-1 focus:ring-peacock">
          <option value="">All buyers</option>
          <option value="customer">Customers</option>
          <option value="dealer">Dealers</option>
        </select>
        <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}
                className="rounded-lg border border-line bg-card px-3 py-2.5 text-ink outline-none focus:border-peacock focus:ring-1 focus:ring-peacock">
          <option value="">All categories</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
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
        <div className="flex flex-wrap gap-1.5 sm:col-span-2 lg:col-span-4">
          {PAYMENT_FILTERS.map(([key, label]) => (
            <button
              key={key} type="button" onClick={() => setPayment(key)}
              className={`rounded-full border px-3 py-1.5 text-sm font-medium transition ${
                payment === key ? 'border-peacock bg-peacock text-white' : 'border-line bg-card text-muted hover:text-ink'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {err && <p className="rounded-lg bg-dues/10 px-4 py-3 text-sm text-dues">{err}</p>}

      {sales === null ? (
        <div className="grid place-items-center py-16 text-muted"><Spinner /></div>
      ) : filtered.length === 0 ? (
        <div className="grid place-items-center gap-3 rounded-lg border border-dashed border-line py-16 text-center text-muted">
          <IconInbox size={38} stroke={1.3} />
          <p>{sales.length === 0 ? 'No sales yet. Approve an order to record the first sale.' : 'No sales match these filters.'}</p>
        </div>
      ) : (
        <ul className="space-y-2.5">
          {filtered.map((s) => {
            const pay = PAYMENT_META[s.payment_type] || { label: s.payment_type, tone: 'muted' }
            const invNo = invoiceNoFor(s)
            return (
              <li key={s.id}>
                <Link
                  to={`/owner/sales/${s.id}`}
                  className="flex items-center gap-4 rounded-lg border border-line bg-card p-3 transition hover:border-ink/20"
                >
                  <PhotoThumb url={s.item?.photo_url} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-ink">{s.item?.name || s.item_name || 'Item'}</p>
                    <p className="truncate text-xs text-muted">
                      {invNo && <span className="fig mr-2 text-ink/70">{invNo}</span>}
                      {s.buyer?.full_name || 'Buyer'}
                      <Badge tone={s.buyer_type === 'dealer' ? 'peacock' : 'muted'} className="ml-1.5">
                        {s.buyer_type}
                      </Badge>
                      <span className="ml-2">{dateTime(s.created_at)}</span>
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="fig font-semibold">{money(s.amount).replace('₹', currency)}</p>
                    <p className="text-xs text-profit">+<span className="fig">{money(s.profit).replace('₹', currency)}</span></p>
                  </div>
                  <Badge tone={pay.tone}>{pay.label}</Badge>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

// One line of the export menu. The count is the point: it says what you are
// about to get, and a zero tells you why the file would be empty.
function ExportChoice({ label, count, onClick }) {
  return (
    <button
      type="button" onClick={onClick} disabled={count === 0}
      className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-sm text-ink transition hover:bg-paper-2 disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {label}
      <span className="fig text-xs text-muted">{qty(count)}</span>
    </button>
  )
}

function Stat({ label, value, accent }) {
  return (
    <div className={`rounded-lg border bg-card px-5 py-3 ${accent ? 'border-profit/30' : 'border-line'}`}>
      <p className="flex items-center gap-1.5 text-xs text-muted">
        {accent && <IconCoin size={14} className="text-profit" />}{label}
      </p>
      <p className="mt-0.5 text-2xl font-bold">{value}</p>
    </div>
  )
}

