import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  IconPhone, IconCashBanknote, IconDeviceFloppy,
  IconFileText, IconBrandWhatsapp, IconAlertTriangle, IconCheck,
} from '@tabler/icons-react'
import { supabase } from '../../lib/supabase'
import { useShop } from '../../context/ShopContext'
import { useAuth } from '../../context/AuthContext'
import { money, dateShort, dateTime } from '../../lib/format'
import { round2, toE164India } from '../../lib/helpers'
import { buildStatementModel, viewStatement, printStatement } from '../../lib/statementTemplate'
import { Badge, Spinner, Button, Field, Textarea, Select } from '../../components/ui'
import LedgerTable from '../../components/LedgerTable'
import { BackLink } from '../../components/BackButton'

// SPEC §6.7 / §6.10 — Party detail. Everything the owner needs about one party
// on ONE screen (SPEC §3.2): who they are, what they have done with the shop,
// what is still owed and how old it is, which bills are open, and the full
// ledger — plus a printable Statement of Account to send them.
//
// Every figure here is read from the migration-052 views, which derive from the
// trigger-written ledger. Nothing on this page computes a balance of its own
// (Golden Rule #10) and nothing writes to the ledger (Golden Rule #9).
const VALID_TYPES = ['customer', 'dealer', 'supplier']

// Statement periods. Opening balance is derived from the ledger rows before the
// start date, so any period foots exactly.
const PERIODS = [
  ['all', 'Since the account opened'],
  ['fy', 'This financial year (Apr–Mar)'],
  ['90', 'Last 90 days'],
  ['30', 'Last 30 days'],
]

function periodStart(key) {
  const now = new Date()
  if (key === 'all') return null
  if (key === 'fy') {
    // Indian FY starts 1 April.
    const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1
    return new Date(y, 3, 1)
  }
  const d = new Date(now)
  d.setDate(d.getDate() - Number(key))
  return d
}

export default function PartyDetail() {
  const { type, id } = useParams()
  const { currency, shop } = useShop()
  const { profile } = useAuth()
  const isOwner = profile?.role === 'owner'

  const [summary, setSummary] = useState(null)
  const [entries, setEntries] = useState(null)
  const [openBills, setOpenBills] = useState([])
  const [bills, setBills] = useState([])
  const [err, setErr] = useState('')
  const [missing, setMissing] = useState(false)
  const [view, setView] = useState('outstanding')
  const [period, setPeriod] = useState('all')

  useEffect(() => {
    let active = true
    async function load() {
      setErr(''); setMissing(false)
      if (!VALID_TYPES.includes(type)) { setMissing(true); return }

      const [sRes, lRes, oRes, bRes] = await Promise.all([
        supabase.from('party_summary').select('*')
          .eq('party_id', id).eq('party_type', type).maybeSingle(),
        // Ascending: the statement needs chronological order to foot, and the
        // on-screen ledger simply reverses it.
        supabase.from('ledger_entries').select('*')
          .eq('party_id', id).eq('party_type', type)
          .order('created_at', { ascending: true }),
        supabase.from('party_open_bills').select('*')
          .eq('party_id', id).eq('party_type', type)
          .order('billed_at', { ascending: true }),
        supabase.from('party_bills').select('*')
          .eq('party_id', id).eq('party_type', type)
          .order('billed_at', { ascending: false }),
      ])
      if (!active) return

      if (sRes.error) { setErr(sRes.error.message); return }
      if (!sRes.data) { setMissing(true); return }
      setSummary(sRes.data)
      if (lRes.error) setErr(lRes.error.message)
      else setEntries(lRes.data ?? [])
      if (oRes.data) setOpenBills(oRes.data)
      if (bRes.data) setBills(bRes.data)
    }
    load()
    return () => { active = false }
  }, [type, id])

  // Statement model for the chosen period. Opening balance is the sum of every
  // balance movement BEFORE the start date — exact, since the ledger's total
  // movement equals balance_due.
  const statement = useMemo(() => {
    if (!summary || !entries) return null
    const from = periodStart(period)
    const inPeriod = from ? entries.filter((e) => new Date(e.created_at) >= from) : entries
    const opening = from
      ? round2(entries
          .filter((e) => new Date(e.created_at) < from)
          .reduce((s, e) => s + Number(e.balance_delta || 0), 0))
      : 0
    return buildStatementModel({
      shop, party: summary, entries: inPeriod, openingBalance: opening,
      from, openBills, currency,
    })
  }, [summary, entries, openBills, period, shop, currency])

  if (missing) return (
    <Empty>Party not found. <Link to="/owner/parties" className="font-medium text-peacock hover:underline">Back to parties</Link>.</Empty>
  )
  if (err && !summary) return <Empty>{err}</Empty>
  if (!summary) return <div className="grid place-items-center py-20 text-muted"><Spinner /></div>

  const isSupplier = type === 'supplier'
  const balance = Number(summary.balance_due || 0)
  const openCount = Number(summary.open_bill_count || 0)

  const ledgerRows = [...(entries || [])].reverse()   // newest first on screen
  const paymentRows = ledgerRows.filter((e) => e.reference_table === 'payments')

  const VIEWS = [
    ['outstanding', openCount ? `Outstanding (${openCount})` : 'Outstanding'],
    ['bills', isSupplier ? `Bills (${bills.length})` : `Sales (${bills.length})`],
    ['payments', `Payments (${paymentRows.length})`],
    ['ledger', 'Full ledger'],
  ]

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <BackLink />

      <PartyHeader
        summary={summary} type={type} currency={currency} shop={shop}
        balance={balance}
      />

      {/* What this party is worth to the shop (SPEC §3.3 — every number labelled) */}
      <StatsRow summary={summary} currency={currency} isSupplier={isSupplier} isOwner={isOwner} />

      <BalanceCard
        summary={summary} isSupplier={isSupplier} currency={currency}
        balance={balance}
      />

      {/* The ledger and balance_due disagreeing means a trigger has drifted —
          the books, not a display bug. Say so loudly rather than quietly
          showing a wrong figure. */}
      {Number(summary.balance_drift || 0) !== 0 && (
        <p className="flex items-start gap-2 rounded-lg border border-dues/30 bg-dues/10 px-4 py-3 text-sm text-dues">
          <IconAlertTriangle size={18} className="mt-0.5 shrink-0" />
          <span>
            This party's balance ({money(balance).replace('₹', currency)}) does not match the ledger
            ({money(summary.computed_balance).replace('₹', currency)}) — a difference of{' '}
            <b className="fig">{money(Math.abs(summary.balance_drift)).replace('₹', currency)}</b>.
            Nothing here is wrong to look at, but the books need checking before you rely on this figure.
          </span>
        </p>
      )}

      <StatementBar
        statement={statement} period={period} setPeriod={setPeriod}
        summary={summary} currency={currency}
      />

      {/* Billing details for the invoice's Bill-To block. Buyers only —
          suppliers keep their own contact/address fields. */}
      {!isSupplier && (
        <BillingEditor
          party={summary}
          onSaved={(patch) => setSummary((p) => ({ ...p, ...patch }))}
        />
      )}

      {/* One screen, four ways to read it (SPEC §3.2 — never a third screen). */}
      <div className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {VIEWS.map(([key, label]) => (
            <button
              key={key} type="button" onClick={() => setView(key)}
              className={`rounded-full border px-3 py-1.5 text-sm font-medium transition ${
                view === key ? 'border-peacock bg-peacock text-white' : 'border-line bg-card text-muted hover:text-ink'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {entries === null ? (
          <div className="grid place-items-center py-12 text-muted"><Spinner /></div>
        ) : view === 'outstanding' ? (
          <OutstandingBills
            bills={openBills} summary={summary} currency={currency} isSupplier={isSupplier}
          />
        ) : view === 'bills' ? (
          <BillList bills={bills} currency={currency} isSupplier={isSupplier} />
        ) : view === 'payments' ? (
          <LedgerTable
            entries={paymentRows} currency={currency}
            emptyText={isSupplier
              ? 'No payment has been made to this supplier yet.'
              : 'No payment has been received from this party yet.'}
          />
        ) : (
          <LedgerTable entries={ledgerRows} currency={currency} />
        )}
      </div>

      {err && summary && <p className="rounded-lg bg-dues/10 px-4 py-3 text-sm text-dues">{err}</p>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Header — who they are, plus the two actions that start a task.
// ---------------------------------------------------------------------------
function PartyHeader({ summary, type, currency, shop, balance }) {
  const isSupplier = type === 'supplier'
  const payDirection = isSupplier ? 'out' : 'in'
  const e164 = toE164India(summary.phone)

  // A reminder the owner can read before sending — never sent silently.
  function remind() {
    const owed = money(Math.abs(balance)).replace('₹', currency)
    const shopName = shop?.name || 'our shop'
    const text = isSupplier
      ? `Hello ${summary.name}, this is ${shopName}. Our records show ${owed} payable to you. Please share your account statement so we can settle it.`
      : `Hello ${summary.name}, this is ${shopName}. A balance of ${owed} is pending on your account. Kindly arrange the payment at your convenience. Thank you!`
    window.open(`https://wa.me/${e164.replace('+', '')}?text=${encodeURIComponent(text)}`,
      '_blank', 'noopener')
  }

  return (
    <div className="rounded-lg border border-line bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-xl font-bold">{summary.name || 'Unnamed'}</h2>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
            <Badge tone={type === 'dealer' ? 'peacock' : isSupplier ? 'saffron' : 'muted'} className="capitalize">{type}</Badge>
            {summary.phone && (
              <a href={`tel:${summary.phone}`} className="fig inline-flex items-center gap-1 hover:text-ink">
                <IconPhone size={14} /> {summary.phone}
              </a>
            )}
            {summary.is_active === false && <Badge tone="dues">Inactive</Badge>}
            <span>On the books since {dateShort(summary.party_since)}</span>
          </p>

          {/* Facts, read-only. The editor below is for changing them. */}
          <div className="mt-2 space-y-0.5 text-sm text-muted">
            {summary.contact_person && <p>Contact: <span className="text-ink">{summary.contact_person}</span></p>}
            {summary.gstin && <p>GSTIN: <span className="fig text-ink">{summary.gstin}</span></p>}
            {summary.address && <p>{summary.address}</p>}
            {(summary.state_name || summary.state_code) && (
              <p>State: <span className="text-ink">{summary.state_name}{summary.state_code ? ` (${summary.state_code})` : ''}</span></p>
            )}
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          {e164 && balance !== 0 && (
            <button
              type="button" onClick={remind}
              className="inline-flex items-center gap-2 rounded-lg border border-line px-3.5 py-2.5 text-sm font-semibold text-[#25D366] transition hover:border-[#25D366] hover:bg-[#25D366]/10"
            >
              <IconBrandWhatsapp size={18} /> Remind
            </button>
          )}
          <Link
            to={`/owner/payments?direction=${payDirection}&id=${summary.party_id}`}
            className="inline-flex items-center gap-2 rounded-lg bg-peacock px-4 py-2.5 text-sm font-semibold text-white hover:bg-peacock-700"
          >
            <IconCashBanknote size={18} /> Record Payment
          </Link>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Lifetime figures. `profit_total` is reachable only through owner-only sales
// (RLS), so staff get null — but gate it in the UI too rather than relying on
// the query alone (CLAUDE.md: never hide by UI only, never rely on RLS only).
// ---------------------------------------------------------------------------
function StatsRow({ summary, currency, isSupplier, isOwner }) {
  const stats = [
    { label: isSupplier ? 'Total purchased from them' : 'Total business done',
      value: money(summary.business_total).replace('₹', currency) },
    { label: isSupplier ? 'Total we have paid' : 'Total received',
      value: money(summary.settled_total).replace('₹', currency) },
    { label: isSupplier ? 'Bills entered' : 'Bills made',
      value: String(summary.bill_count) },
    { label: 'Average bill',
      value: money(summary.avg_bill_value).replace('₹', currency) },
    { label: 'Biggest bill',
      value: money(summary.largest_bill).replace('₹', currency) },
    { label: 'Last activity',
      value: summary.last_txn_at ? dateShort(summary.last_txn_at) : 'Never',
      hint: summary.days_since_last_txn != null
        ? (summary.days_since_last_txn === 0 ? 'today' : `${summary.days_since_last_txn} days ago`)
        : 'no transactions yet' },
  ]
  if (isOwner && !isSupplier && summary.profit_total != null) {
    stats.push({
      label: 'Profit earned from them',
      value: money(summary.profit_total).replace('₹', currency),
      tone: 'profit',
    })
  }

  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-3 lg:grid-cols-4">
      {stats.map((s) => (
        <div key={s.label} className="bg-card px-4 py-3">
          <p className="text-xs text-muted">{s.label}</p>
          <p className={`fig mt-0.5 text-lg font-bold ${s.tone === 'profit' ? 'text-profit' : 'text-ink'}`}>{s.value}</p>
          {s.hint && <p className="text-xs text-muted">{s.hint}</p>}
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Balance, with the ageing split that says how worried to be.
//
// A NEGATIVE balance is an advance the shop is holding (or has parked with a
// supplier) — real money the old "Settled" label hid completely.
// ---------------------------------------------------------------------------
function BalanceCard({ summary, isSupplier, currency, balance }) {
  const advance = balance < 0
  const settled = balance === 0
  const buckets = [
    ['0-30 days', summary.due_0_30],
    ['31-60 days', summary.due_31_60],
    ['61-90 days', summary.due_61_90],
    ['Over 90 days', summary.due_90_plus],
  ].filter(([, v]) => Number(v) > 0)

  const label = settled ? 'All settled'
    : advance ? (isSupplier ? 'Advance sitting with this supplier' : 'Advance held from this party')
    : isSupplier ? 'We owe this supplier' : 'Udhaar owed to shop'

  const tone = settled ? 'profit' : advance ? 'peacock' : 'dues'

  return (
    <div className={`rounded-lg border p-5 ${
      tone === 'profit' ? 'border-profit/30 bg-profit/10'
      : tone === 'peacock' ? 'border-peacock/30 bg-peacock/10'
      : 'border-dues/30 bg-dues/10'
    }`}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-muted">{label}</p>
          <p className={`fig mt-1 text-3xl font-bold ${
            tone === 'profit' ? 'text-profit' : tone === 'peacock' ? 'text-peacock' : 'text-dues'
          }`}>
            {money(Math.abs(balance)).replace('₹', currency)}
          </p>
          <p className="mt-1 text-xs text-muted">
            {settled ? 'Nothing outstanding either way.'
              : advance ? (isSupplier
                  ? 'Paid ahead of the bills. It will absorb their next bill.'
                  : 'Paid more than billed. It will absorb their next udhaar bill.')
              : isSupplier ? 'Clear this with a Payment Out entry.'
              : 'Clear this with a Payment In entry.'}
          </p>
        </div>

        {summary.oldest_open_days != null && (
          <div className="text-right">
            <p className="text-xs text-muted">Oldest unpaid bill</p>
            <p className={`fig text-lg font-bold ${summary.oldest_open_days > 60 ? 'text-dues' : 'text-ink'}`}>
              {summary.oldest_open_days} days
            </p>
            <p className="text-xs text-muted">{dateShort(summary.oldest_open_at)}</p>
          </div>
        )}
      </div>

      {buckets.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2 border-t border-line/60 pt-3">
          {buckets.map(([label2, v]) => (
            <span key={label2} className="rounded-full border border-line bg-card px-3 py-1 text-xs text-muted">
              {label2} <b className="fig text-ink">{money(v).replace('₹', currency)}</b>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Statement of Account — pick a period, look at it, print it (→ Save as PDF).
// ---------------------------------------------------------------------------
function StatementBar({ statement, period, setPeriod, summary, currency }) {
  const rows = statement?.rows?.length ?? 0
  return (
    <div className="rounded-lg border border-line bg-card p-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-[14rem] flex-1">
          <h3 className="font-semibold text-ink">Statement of Account</h3>
          <p className="text-xs text-muted">
            The money-on-account record to hand this party. Bills paid in cash or UPI at the
            counter are settled on the spot, so they are not account transactions and do not appear.
          </p>
          <div className="mt-3 max-w-xs">
            <Select label="Period" value={period} onChange={(e) => setPeriod(e.target.value)}>
              {PERIODS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </Select>
          </div>
          <p className="mt-2 text-xs text-muted">
            {rows === 0
              ? 'No account transactions in this period — the statement will print as nil.'
              : `${rows} entr${rows === 1 ? 'y' : 'ies'}, closing balance ${money(statement.closingBalance).replace('₹', currency)}.`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => viewStatement(statement)} disabled={!statement}>
            <IconFileText size={18} /> View statement
          </Button>
          <Button variant="ghost" onClick={() => printStatement(statement)} disabled={!statement}>
            <IconDeviceFloppy size={18} /> Print / Save PDF
          </Button>
        </div>
      </div>
      {Number(summary.outstanding_total) > 0 && (
        <p className="mt-3 border-t border-line pt-3 text-xs text-muted">
          Sending a reminder? The statement's closing balance is{' '}
          <b className="fig text-ink">{money(summary.outstanding_total).replace('₹', currency)}</b> outstanding
          across {summary.open_bill_count} bill{summary.open_bill_count === 1 ? '' : 's'}.
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Bill-wise outstanding.
//
// Payments in this system are independent of invoices (Golden Rule #8) — a
// receipt just lowers balance_due, it is never tied to a bill. So "which bills
// are open" is DERIVED oldest-first by party_open_bills, and the screen says so
// rather than implying the shop tracked it per bill all along.
// ---------------------------------------------------------------------------
function OutstandingBills({ bills, summary, currency, isSupplier }) {
  const open = bills.filter((b) => Number(b.outstanding) > 0)

  if (!open.length) {
    return (
      <div className="grid place-items-center gap-3 rounded-lg border border-dashed border-line py-14 text-center text-muted">
        <IconCheck size={36} stroke={1.3} className="text-profit" />
        <p>
          Nothing outstanding.{' '}
          {Number(summary.balance_due) < 0 && 'This party is in advance — see the balance above.'}
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-2.5">
      <p className="text-xs text-muted">
        Payments are not tied to a bill, so the oldest bill is treated as paid first.
      </p>
      {open.map((b) => {
        const part = Number(b.paid_amount) > 0
        const old = b.age_days > 60
        return (
          <Link
            key={b.bill_key}
            to={b.bill_kind === 'purchase' ? `/owner/purchases/${b.detail_ref}` : `/owner/sales/${b.detail_ref}`}
            className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-line bg-card p-4 transition hover:border-ink/20"
          >
            <div className="min-w-0 flex-1">
              <p className="font-medium text-ink">
                {b.invoice_no ? <span className="fig">Bill {b.invoice_no}</span> : 'Bill'}
                <span className="ml-2 text-sm font-normal text-muted">
                  {b.entry_count} {isSupplier ? 'line' : 'item'}{b.entry_count === 1 ? '' : 's'}
                </span>
              </p>
              <p className="text-xs text-muted">
                {dateShort(b.supplier_invoice_date || b.billed_at)} · {b.age_days} days old
                {part && (
                  <> · part paid <span className="fig">{money(b.paid_amount).replace('₹', currency)}</span> of{' '}
                    <span className="fig">{money(b.credit_amount).replace('₹', currency)}</span></>
                )}
              </p>
            </div>
            <Badge tone={old ? 'dues' : 'muted'}>{b.age_bucket === '90+' ? 'Over 90 days' : `${b.age_bucket} days`}</Badge>
            <div className="text-right">
              <p className={`fig font-semibold ${old ? 'text-dues' : 'text-ink'}`}>
                {money(b.outstanding).replace('₹', currency)}
              </p>
              <p className="text-xs text-muted">still open</p>
            </div>
          </Link>
        )
      })}
      <div className="flex items-center justify-between rounded-lg border border-line bg-paper-2 px-4 py-3">
        <span className="text-sm font-medium text-ink">Total outstanding</span>
        <span className="fig text-lg font-bold text-dues">
          {money(summary.outstanding_total).replace('₹', currency)}
        </span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Every bill, paid or not — the ledger rolled up per document rather than per
// line. A 6-item counter bill is one row here and six in the full ledger.
// ---------------------------------------------------------------------------
function BillList({ bills, currency, isSupplier }) {
  if (!bills.length) {
    return (
      <div className="grid place-items-center gap-3 rounded-lg border border-dashed border-line py-14 text-center text-muted">
        <IconFileText size={36} stroke={1.3} />
        <p>No bills for this party yet.</p>
      </div>
    )
  }
  return (
    <ul className="space-y-2.5">
      {bills.map((b) => (
        <li key={b.bill_key}>
          <Link
            to={b.bill_kind === 'purchase' ? `/owner/purchases/${b.detail_ref}` : `/owner/sales/${b.detail_ref}`}
            className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-line bg-card p-4 transition hover:border-ink/20"
          >
            <div className="min-w-0 flex-1">
              <p className="font-medium text-ink">
                {b.invoice_no ? <span className="fig">Bill {b.invoice_no}</span> : 'Bill'}
                <span className="ml-2 text-sm font-normal text-muted">
                  {b.entry_count} {isSupplier ? 'line' : 'item'}{b.entry_count === 1 ? '' : 's'}
                </span>
              </p>
              <p className="text-xs text-muted">{dateTime(b.billed_at)}</p>
            </div>
            {/* How it was settled. A counter bill never joined the account. */}
            <Badge tone={b.on_credit ? 'saffron' : 'profit'}>
              {b.on_credit ? 'On udhaar' : b.payment_type === 'upi' ? 'Paid by UPI'
                : b.payment_type === 'cash' ? 'Paid in cash' : 'Settled'}
            </Badge>
            <div className="text-right">
              <p className="fig font-semibold text-ink">{money(b.bill_total).replace('₹', currency)}</p>
              <p className="text-xs text-muted">bill total</p>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  )
}

// Owner-editable GST number + full address for a buyer. Optional; printed as the
// "Bill To" block on customer invoices and on the statement. Writes via the
// profiles owner-update policy.
function BillingEditor({ party, onSaved }) {
  const [form, setForm] = useState({
    gstin: party.gstin || '', address: party.address || '',
    state_name: party.state_name || '', state_code: party.state_code || '',
  })
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const set = (k) => (e) => { setForm((f) => ({ ...f, [k]: e.target.value })); setMsg(''); setErr('') }

  async function save(e) {
    e.preventDefault()
    setSaving(true); setMsg(''); setErr('')
    const patch = {
      gstin: form.gstin.trim() || null, address: form.address.trim() || null,
      state_name: form.state_name.trim() || null, state_code: form.state_code.trim() || null,
    }
    const { error } = await supabase.from('profiles').update(patch).eq('id', party.party_id)
    setSaving(false)
    if (error) setErr(error.message)
    else { setMsg('Billing details saved.'); onSaved(patch) }
  }

  // Collapsed by default — the details are already shown as facts in the
  // header, so this is an edit tool, not a fifth block of reading.
  if (!open) {
    return (
      <button
        type="button" onClick={() => setOpen(true)}
        className="w-full rounded-lg border border-dashed border-line px-4 py-3 text-sm font-medium text-muted transition hover:border-ink/20 hover:text-ink"
      >
        {party.gstin || party.address ? 'Edit billing details' : 'Add GST number & address for invoices'}
      </button>
    )
  }

  return (
    <form onSubmit={save} className="space-y-4 rounded-lg border border-line bg-card p-5">
      <div>
        <h3 className="font-semibold text-ink">Billing details</h3>
        <p className="text-xs text-muted">GST number &amp; address for this buyer's invoice and statement. Both optional.</p>
      </div>
      <Field label="GST number" value={form.gstin} onChange={set('gstin')} placeholder="e.g. 27ABCDE1234F1Z5" />
      <Textarea label="Full address" rows={3} value={form.address} onChange={set('address')}
                placeholder="Street, area, city, state — PIN." />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="State name" value={form.state_name} onChange={set('state_name')} placeholder="e.g. Uttar Pradesh" />
        <Field label="State code" value={form.state_code} onChange={set('state_code')} placeholder="e.g. 09" maxLength={2} />
      </div>
      {msg && <p className="rounded-lg bg-profit/10 px-3 py-2 text-xs text-profit">{msg}</p>}
      {err && <p className="rounded-lg bg-dues/10 px-3 py-2 text-xs text-dues">{err}</p>}
      <div className="flex gap-2">
        <Button type="submit" disabled={saving}>
          {saving ? <Spinner /> : <IconDeviceFloppy size={18} />} Save billing details
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Close</Button>
      </div>
    </form>
  )
}

function Empty({ children }) {
  return <div className="mx-auto max-w-md rounded-lg border border-dashed border-line p-10 text-center text-muted">{children}</div>
}
