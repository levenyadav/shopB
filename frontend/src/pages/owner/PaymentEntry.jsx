import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import {
  IconCashBanknote, IconArrowDownLeft, IconArrowUpRight,
  IconCircleCheck, IconUsers,
} from '@tabler/icons-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import { useShop } from '../../context/ShopContext'
import { money } from '../../lib/format'
import { round2 } from '../../lib/helpers'
import { Button, Field, Select, Textarea, Spinner, Badge } from '../../components/ui'

// SPEC §6.8 — Payment Entry. Separate from Sale and Purchase (Golden Rule #8).
//   Payment In  → money received from a customer/dealer  → clears their udhaar
//   Payment Out → money paid to a supplier               → clears supplier dues
// The form only INSERTs a payments row; the on_payment_insert trigger moves the
// party balance and writes the ledger (Golden Rules #9, #10). The client never
// touches balance_due or the ledger directly.
const METHODS = [
  ['cash', 'Cash'], ['upi', 'UPI'], ['bank', 'Bank'],
]

export default function PaymentEntry() {
  const navigate = useNavigate()
  const { profile } = useAuth()
  const { currency, suppliers, refreshSuppliers } = useShop()
  const [params] = useSearchParams()

  // Buyers (customers + dealers) for Payment In. Suppliers come from ShopContext.
  const [buyers, setBuyers] = useState(null)
  const [loadErr, setLoadErr] = useState('')

  const [direction, setDirection] = useState(params.get('direction') === 'out' ? 'out' : 'in')
  const [partyId, setPartyId] = useState(params.get('id') || '')
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState('cash')
  const [reference, setReference] = useState('')
  const [notes, setNotes] = useState('')

  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [done, setDone] = useState(null) // { name, paid, balanceAfter }

  useEffect(() => {
    let active = true
    supabase
      .from('profiles')
      .select('id, full_name, phone, role, balance_due')
      .in('role', ['customer', 'dealer'])
      .order('full_name')
      .then(({ data, error }) => {
        if (!active) return
        if (error) setLoadErr(error.message)
        else setBuyers(data ?? [])
      })
    return () => { active = false }
  }, [])

  // The party list + lookup for the chosen direction.
  const parties = direction === 'in' ? (buyers ?? []) : suppliers
  const party = useMemo(
    () => parties.find((p) => p.id === partyId) || null,
    [parties, partyId],
  )
  const partyType = direction === 'in' ? (party?.role || 'customer') : 'supplier'

  const amt = round2(amount)
  const currentBal = Number(party?.balance_due || 0)
  const balanceAfter = round2(currentBal - amt)
  const overpay = party && amt > currentBal

  // Switching direction invalidates the selected party.
  function changeDirection(d) {
    setDirection(d)
    setPartyId('')
    setErr('')
  }

  async function save() {
    setErr('')
    if (!party) { setErr('Choose who the payment is with first.'); return }
    if (!(amt > 0)) { setErr('Enter an amount greater than zero.'); return }

    setBusy(true)
    const { error } = await supabase.from('payments').insert({
      shop_id: profile.shop_id,
      direction,
      party_id: party.id,
      party_type: partyType,
      amount: amt,
      method,
      reference_no: reference.trim() || null,
      notes: notes.trim() || null,
      recorded_by: profile.id,
    })
    setBusy(false)
    if (error) { setErr(error.message); return }

    // Trigger has updated the balance; reflect it and reset the form.
    setDone({ name: partyName(party, direction), paid: amt, balanceAfter, partyType })
    setPartyId(''); setAmount(''); setReference(''); setNotes('')
    if (direction === 'out') refreshSuppliers()
    else setBuyers((b) => b && b.map((x) => (x.id === party.id ? { ...x, balance_due: balanceAfter } : x)))
  }

  if (done) return <Success done={done} currency={currency} onAnother={() => setDone(null)} />

  return (
    <div className="mx-auto max-w-xl space-y-5">
      {/* Direction — the one big choice that reshapes everything below */}
      <div className="grid grid-cols-2 gap-3">
        <DirCard
          active={direction === 'in'} onClick={() => changeDirection('in')}
          icon={IconArrowDownLeft} title="Payment In"
          sub="Received from a customer or dealer" iconClass="bg-profit/10 text-profit"
        />
        <DirCard
          active={direction === 'out'} onClick={() => changeDirection('out')}
          icon={IconArrowUpRight} title="Payment Out"
          sub="Paid to a supplier" iconClass="bg-dues/10 text-dues"
        />
      </div>

      <div className="space-y-4 rounded-lg border border-line bg-card p-5">
        {/* Party */}
        {direction === 'in' && buyers === null ? (
          <div className="flex items-center gap-2 text-sm text-muted"><Spinner /> Loading parties…</div>
        ) : parties.length === 0 ? (
          <NoParties direction={direction} />
        ) : (
          <Select
            label={direction === 'in' ? 'Received from' : 'Paid to'}
            value={partyId}
            onChange={(e) => { setPartyId(e.target.value); setErr('') }}
          >
            <option value="">Choose {direction === 'in' ? 'customer / dealer' : 'supplier'}…</option>
            {parties.map((p) => (
              <option key={p.id} value={p.id}>
                {partyName(p, direction)}
                {Number(p.balance_due) > 0 ? ` — ${money(p.balance_due).replace('₹', currency)} due` : ''}
              </option>
            ))}
          </Select>
        )}

        {/* Selected party's standing */}
        {party && (
          <div className="flex items-center justify-between rounded-lg bg-paper-2 px-4 py-3 text-sm">
            <span className="text-muted">
              {direction === 'in' ? 'Udhaar outstanding' : 'We currently owe'}
            </span>
            <span className={`fig font-semibold ${currentBal > 0 ? 'text-dues' : 'text-profit'}`}>
              {money(currentBal).replace('₹', currency)}
            </span>
          </div>
        )}

        <Field
          label="Amount" type="number" inputMode="decimal" min="0" step="0.01"
          prefix={currency} value={amount}
          onChange={(e) => setAmount(e.target.value)} placeholder="0"
        />

        {/* Method */}
        <div>
          <p className="mb-1.5 text-sm font-medium">Paid by</p>
          <div className="grid grid-cols-3 gap-2">
            {METHODS.map(([key, label]) => (
              <button
                key={key} type="button" onClick={() => setMethod(key)}
                className={`rounded-lg border px-3 py-2.5 text-sm font-medium transition ${
                  method === key ? 'border-peacock bg-peacock/10 text-peacock' : 'border-line bg-card text-muted hover:text-ink'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <Field
          label="Reference no (optional)"
          value={reference} onChange={(e) => setReference(e.target.value)}
          placeholder="UPI ref / cheque no"
        />
        <Textarea
          label="Note (optional)" rows={2}
          value={notes} onChange={(e) => setNotes(e.target.value)}
        />

        {/* Resulting balance preview */}
        {party && amt > 0 && (
          <div className="flex items-center justify-between border-t border-line pt-3 text-sm">
            <span className="text-muted">Balance after this payment</span>
            <span className={`fig font-semibold ${balanceAfter > 0 ? 'text-dues' : 'text-profit'}`}>
              {money(Math.max(0, balanceAfter)).replace('₹', currency)}
              {overpay && <Badge tone="saffron" className="ml-2">advance</Badge>}
            </span>
          </div>
        )}
        {overpay && (
          <p className="text-xs text-saffron">
            This is more than the outstanding balance — the extra is kept as an advance
            (the balance goes into credit).
          </p>
        )}

        {err && <p className="rounded-lg bg-dues/10 px-3 py-2 text-sm text-dues">{err}</p>}

        <Button onClick={save} disabled={busy || !party} className="w-full">
          {busy ? <><Spinner /> Recording…</> : <><IconCashBanknote size={18} /> Record payment</>}
        </Button>
      </div>

      {loadErr && <p className="rounded-lg bg-dues/10 px-4 py-3 text-sm text-dues">{loadErr}</p>}
    </div>
  )
}

function partyName(p, direction) {
  if (direction === 'in') {
    return `${p.full_name || 'Buyer'}${p.role === 'dealer' ? ' (Dealer)' : ''}`
  }
  return p.name || 'Supplier'
}

function DirCard({ active, onClick, icon: Icon, title, sub, iconClass }) {
  return (
    <button
      type="button" onClick={onClick}
      className={`rounded-lg border p-4 text-left transition ${
        active ? 'border-peacock bg-peacock/5 shadow-sm' : 'border-line bg-card hover:bg-paper-2'
      }`}
    >
      <span className={`mb-2 inline-grid h-9 w-9 place-items-center rounded-full ${iconClass}`}>
        <Icon size={20} />
      </span>
      <p className="font-semibold">{title}</p>
      <p className="text-xs text-muted">{sub}</p>
    </button>
  )
}

function NoParties({ direction }) {
  return (
    <div className="grid place-items-center gap-2 rounded-lg border border-dashed border-line py-8 text-center text-sm text-muted">
      <IconUsers size={28} stroke={1.3} />
      {direction === 'in'
        ? <p>No customers or dealers yet. They appear here once they register on the shopfront.</p>
        : <p>No suppliers yet. Add one from a <Link to="/owner/purchase" className="font-medium text-peacock hover:underline">Purchase Entry</Link>.</p>}
    </div>
  )
}

function Success({ done, currency, onAnother }) {
  return (
    <div className="mx-auto max-w-md space-y-5 rounded-lg border border-profit/30 bg-profit/10 p-8 text-center">
      <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-profit/15 text-profit">
        <IconCircleCheck size={30} />
      </div>
      <div>
        <h2 className="text-xl font-bold">Payment recorded</h2>
        <p className="mt-1 text-muted">
          <span className="fig font-semibold text-ink">{money(done.paid).replace('₹', currency)}</span>
          {' '}{done.partyType === 'supplier' ? 'paid to' : 'received from'} {done.name}.
        </p>
        <p className="mt-1 text-sm text-muted">
          {done.partyType === 'supplier' ? 'We now owe' : 'Balance now'}{' '}
          <span className="fig font-semibold text-dues">{money(Math.max(0, done.balanceAfter)).replace('₹', currency)}</span>.
        </p>
      </div>
      <div className="flex justify-center gap-3">
        <Button onClick={onAnother}>Record another</Button>
        <Link to="/owner/parties" className="rounded-lg border border-line bg-card px-4 py-2.5 text-sm font-semibold hover:bg-paper-2">
          View parties
        </Link>
      </div>
    </div>
  )
}
