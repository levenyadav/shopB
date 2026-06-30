import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  IconSearch, IconBarcode, IconPlus, IconMinus, IconTrash, IconUserPlus,
  IconCheck, IconPrinter, IconX, IconShoppingCart, IconArrowLeft,
} from '@tabler/icons-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import { useShop } from '../../context/ShopContext'
import { money, qty } from '../../lib/format'
import { rateForBuyer, lineProfit, round2 } from '../../lib/helpers'
import { Button, Field, Spinner, Badge, PhotoThumb } from '../../components/ui'
import BarcodeScanner from '../../components/BarcodeScanner'
import CounterReceipt from '../../components/CounterReceipt'

// POS / Counter Sale (SPEC §6.5a — walk-in billing). Owner OR staff ring up a
// walk-in on the spot: scan/search items into a cart, pick or quick-add a named
// buyer, take payment, and finalize via the atomic create_counter_sale RPC (one
// transaction → stock drops, ledger/udhaar booked, fulfilment auto-completed).
const PAYMENTS = [['cash', 'Cash'], ['upi', 'UPI'], ['udhaar', 'Udhaar (credit)']]

export default function CounterSale() {
  const { profile } = useAuth()
  const { shop, shopId, currency } = useShop()
  const navigate = useNavigate()
  const isOwner = profile?.role === 'owner'
  const home = isOwner ? '/owner' : '/staff'
  const m = (n) => money(n).replace('₹', currency)

  const [cart, setCart] = useState([])   // { id, item_no, name, category_id, photo_url, stock, rate, dealer_rate, purchase_rate, quantity, charge }
  const [buyer, setBuyer] = useState(null) // { id, full_name, phone, role }
  const [payment, setPayment] = useState('cash')
  const [tendered, setTendered] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [done, setDone] = useState(null)  // completed bill → receipt screen

  const buyerType = buyer?.role === 'dealer' ? 'dealer' : 'customer'
  const total = useMemo(() => round2(cart.reduce((s, l) => s + l.charge * l.quantity, 0)), [cart])
  const profit = useMemo(
    () => round2(cart.reduce((s, l) => s + lineProfit(l.charge, l.purchase_rate ?? 0, l.quantity), 0)),
    [cart],
  )

  // Re-price every line when the buyer (and thus the tier) changes — dealer pays
  // dealer_rate, customer pays retail. A manual charge override is reset here; the
  // buyer is normally chosen before fine-tuning a price.
  useEffect(() => {
    setCart((ls) => ls.map((l) => ({ ...l, charge: rateForBuyer(l, buyerType) })))
  }, [buyerType])

  function addItem(it) {
    setErr('')
    setCart((ls) => {
      const i = ls.findIndex((l) => l.id === it.id)
      if (i >= 0) {
        const next = [...ls]
        next[i] = { ...next[i], quantity: Math.min(next[i].quantity + 1, Number(it.quantity) || next[i].quantity) }
        return next
      }
      return [...ls, {
        id: it.id, item_no: it.item_no, name: it.name, category_id: it.category_id,
        photo_url: it.photo_url, stock: Number(it.quantity) || 0,
        rate: Number(it.rate), dealer_rate: Number(it.dealer_rate),
        purchase_rate: Number(it.purchase_rate ?? 0),
        quantity: 1, charge: rateForBuyer(it, buyerType),
      }]
    })
  }
  const setLine = (id, patch) => setCart((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)))
  const removeLine = (id) => setCart((ls) => ls.filter((l) => l.id !== id))

  async function confirm() {
    setErr('')
    if (!cart.length) return setErr('Add at least one item to the bill.')
    if (!buyer) return setErr('Choose or add a buyer first.')
    const over = cart.find((l) => l.quantity > l.stock)
    if (over) return setErr(`Only ${qty(over.stock)} of "${over.name}" in stock.`)
    if (cart.some((l) => l.quantity <= 0 || l.charge < 0)) return setErr('Check the quantities and rates.')

    setBusy(true)
    const { data: billId, error } = await supabase.rpc('create_counter_sale', {
      p_buyer_id: buyer.id,
      p_buyer_type: buyerType,
      p_payment_type: payment,
      p_lines: cart.map((l) => ({
        item_id: l.id, category_id: l.category_id, quantity: l.quantity, rate: l.charge,
      })),
    })
    setBusy(false)
    if (error) { setErr(error.message); return }

    setDone({
      bill_id: billId,
      created_at: new Date().toISOString(),
      buyer_name: buyer.full_name, buyer_phone: buyer.phone, buyer_type: buyerType,
      payment_type: payment,
      tendered: payment === 'cash' && tendered !== '' ? Number(tendered) : null,
      total,
      lines: cart.map((l) => ({
        item_name: l.name, item_no: l.item_no, quantity: l.quantity,
        rate: l.charge, amount: round2(l.charge * l.quantity),
      })),
    })
  }

  function reset() {
    setDone(null); setCart([]); setBuyer(null); setPayment('cash'); setTendered(''); setErr('')
  }

  if (done) return <ReceiptScreen bill={done} shop={shop} currency={currency} onNew={reset} home={home} navigate={navigate} />

  return (
    <div className="mx-auto max-w-5xl">
      {!isOwner && (
        <button onClick={() => navigate(home)} className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-ink">
          <IconArrowLeft size={16} /> Back to Fulfilment
        </button>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        {/* ---- Left: item picker ---- */}
        <div>
          <ItemPicker shopId={shopId} isOwner={isOwner} onAdd={addItem} currency={currency} />
        </div>

        {/* ---- Right: the bill ---- */}
        <div className="space-y-4">
          <div className="rounded-lg border border-line bg-card">
            <div className="flex items-center gap-2 border-b border-line px-4 py-3">
              <IconShoppingCart size={18} className="text-peacock" />
              <span className="font-semibold">This bill</span>
              <span className="ml-auto fig text-sm text-muted">{cart.length} item{cart.length === 1 ? '' : 's'}</span>
            </div>

            {cart.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted">Scan or search an item to start the bill.</p>
            ) : (
              <ul className="divide-y divide-line">
                {cart.map((l) => (
                  <li key={l.id} className="flex items-center gap-3 px-3 py-2.5">
                    <PhotoThumb url={l.photo_url} size="h-10 w-10" alt={l.name} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{l.name}</p>
                      <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
                        <span className="fig">{m(l.charge)}</span> each
                        {l.quantity > l.stock && <Badge tone="dues">Over stock</Badge>}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <StepBtn onClick={() => setLine(l.id, { quantity: Math.max(1, l.quantity - 1) })}><IconMinus size={15} /></StepBtn>
                      <input
                        value={l.quantity}
                        onChange={(e) => setLine(l.id, { quantity: Math.max(1, Math.floor(Number(e.target.value) || 1)) })}
                        className="w-10 rounded border border-line bg-paper-2 py-1 text-center fig text-sm"
                        inputMode="numeric"
                      />
                      <StepBtn onClick={() => setLine(l.id, { quantity: Math.min(l.stock, l.quantity + 1) })}><IconPlus size={15} /></StepBtn>
                    </div>
                    <span className="w-16 text-right fig text-sm font-semibold">{m(round2(l.charge * l.quantity))}</span>
                    <button onClick={() => removeLine(l.id)} className="text-muted hover:text-dues" aria-label="Remove">
                      <IconTrash size={16} />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="space-y-1 border-t border-line px-4 py-3">
              <Row label="Total" value={<span className="fig text-lg font-bold">{m(total)}</span>} />
              {isOwner && cart.length > 0 && (
                <Row label="Profit (owner only)" value={<span className="fig text-sm font-semibold text-profit">{m(profit)}</span>} />
              )}
            </div>
          </div>

          <BuyerPanel buyer={buyer} setBuyer={setBuyer} shopId={shopId} />

          <div className="rounded-lg border border-line bg-card p-4">
            <p className="mb-1.5 text-sm font-medium">Payment</p>
            <div className="grid grid-cols-3 gap-2">
              {PAYMENTS.map(([key, label]) => (
                <button
                  key={key} type="button" onClick={() => setPayment(key)}
                  className={`rounded-lg border px-2 py-2 text-sm font-medium transition ${
                    payment === key ? 'border-peacock bg-peacock/10 text-peacock' : 'border-line bg-card text-muted hover:text-ink'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            {payment === 'udhaar' && (
              <p className="mt-2 text-xs text-saffron">
                Adds {m(total)} to {buyer?.full_name || 'the buyer'}’s udhaar. A named buyer is required — clear it later via Payment In.
              </p>
            )}
            {payment === 'cash' && total > 0 && (
              <div className="mt-3 flex items-center justify-between gap-3">
                <Field
                  label="Cash given" prefix={currency} inputMode="numeric" className="w-28"
                  value={tendered} onChange={(e) => setTendered(e.target.value)}
                />
                <div className="pt-5 text-right">
                  <p className="text-xs text-muted">Change</p>
                  <p className="fig font-semibold">{tendered === '' ? '—' : m(Math.max(0, Number(tendered) - total))}</p>
                </div>
              </div>
            )}
          </div>

          {err && <p className="rounded-lg border border-dues/40 bg-dues/5 px-3 py-2 text-sm text-dues">{err}</p>}

          <Button onClick={confirm} disabled={busy || !cart.length} className="w-full py-3 text-base">
            {busy ? <Spinner /> : <IconCheck size={18} />}
            {busy ? 'Saving…' : `Complete sale · ${m(total)}`}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ---- Item picker (search + scan) ---------------------------------------------
function ItemPicker({ shopId, isOwner, onAdd, currency }) {
  const [q, setQ] = useState('')
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(false)
  const [scan, setScan] = useState(false)
  const [flash, setFlash] = useState('')
  const seq = useRef(0)
  const m = (n) => money(n).replace('₹', currency)

  useEffect(() => {
    const id = ++seq.current
    const term = q.trim()
    setLoading(true)
    const t = setTimeout(async () => {
      let query = supabase
        .from('items')
        .select('id, item_no, name, category_id, photo_url, quantity, rate, dealer_rate' + (isOwner ? ', purchase_rate' : ''))
        .eq('shop_id', shopId).eq('is_active', true).gt('quantity', 0)
        .order('name').limit(24)
      if (term) query = query.or(`name.ilike.%${term}%,item_no.ilike.%${term}%`)
      const { data } = await query
      if (id === seq.current) { setRows(data || []); setLoading(false) }
    }, 200)
    return () => clearTimeout(t)
  }, [q, shopId, isOwner])

  async function onScan(code) {
    setScan(false)
    const { data } = await supabase
      .from('items')
      .select('id, item_no, name, category_id, photo_url, quantity, rate, dealer_rate' + (isOwner ? ', purchase_rate' : ''))
      .eq('shop_id', shopId).eq('barcode', code).eq('is_active', true).maybeSingle()
    if (data && Number(data.quantity) > 0) { onAdd(data); setFlash(`Added ${data.name}`); setTimeout(() => setFlash(''), 1500) }
    else setFlash(data ? `${data.name} is out of stock` : `No item for code ${code}`)
  }

  return (
    <div>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <IconSearch size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            autoFocus value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search item by name or number…"
            className="ring-focus w-full rounded-md border border-line bg-card py-2.5 pl-10 pr-3 text-ink"
          />
        </div>
        <Button variant="ghost" onClick={() => setScan(true)}><IconBarcode size={18} /> Scan</Button>
      </div>
      {flash && <p className="mt-2 text-sm text-peacock">{flash}</p>}

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        {loading && rows.length === 0 ? (
          <p className="col-span-full py-8 text-center text-sm text-muted"><Spinner /> Loading…</p>
        ) : rows.length === 0 ? (
          <p className="col-span-full py-8 text-center text-sm text-muted">No items match.</p>
        ) : rows.map((it) => (
          <button
            key={it.id} onClick={() => onAdd(it)}
            className="ring-focus group flex flex-col rounded-lg border border-line bg-card p-2.5 text-left transition hover:border-peacock"
          >
            <PhotoThumb url={it.photo_url} size="h-20 w-full" alt={it.name} />
            <p className="mt-2 line-clamp-2 text-sm font-medium leading-snug">{it.name}</p>
            <div className="mt-1 flex items-center justify-between">
              <span className="fig text-sm font-semibold text-peacock">{m(it.rate)}</span>
              <span className="fig text-xs text-muted">{qty(it.quantity)} left</span>
            </div>
          </button>
        ))}
      </div>

      {scan && <BarcodeScanner onDetected={onScan} onClose={() => setScan(false)} />}
    </div>
  )
}

// ---- Buyer panel (search existing or quick-add) ------------------------------
function BuyerPanel({ buyer, setBuyer, shopId }) {
  const [q, setQ] = useState('')
  const [rows, setRows] = useState([])
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ full_name: '', phone: '', role: 'customer' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const seq = useRef(0)

  useEffect(() => {
    if (buyer || adding) return
    const id = ++seq.current
    const term = q.trim()
    if (!term) { setRows([]); return }
    const t = setTimeout(async () => {
      const { data } = await supabase
        .from('profiles')
        .select('id, full_name, phone, role, balance_due')
        .eq('shop_id', shopId).in('role', ['customer', 'dealer'])
        .or(`full_name.ilike.%${term}%,phone.ilike.%${term}%`)
        .limit(8)
      if (id === seq.current) setRows(data || [])
    }, 200)
    return () => clearTimeout(t)
  }, [q, buyer, adding, shopId])

  async function quickAdd() {
    setErr('')
    if (!form.full_name.trim()) return setErr('Enter the buyer’s name.')
    setBusy(true)
    const { data, error } = await supabase
      .from('profiles')
      .insert({ shop_id: shopId, full_name: form.full_name.trim(), phone: form.phone.trim() || null, role: form.role })
      .select('id, full_name, phone, role, balance_due').single()
    setBusy(false)
    if (error) { setErr(error.message); return }
    setBuyer(data); setAdding(false); setForm({ full_name: '', phone: '', role: 'customer' })
  }

  if (buyer) {
    return (
      <div className="rounded-lg border border-line bg-card p-4">
        <p className="mb-1.5 text-sm font-medium">Buyer</p>
        <div className="flex items-center justify-between gap-3 rounded-lg border border-peacock/30 bg-peacock/5 px-3 py-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{buyer.full_name} <Badge tone={buyer.role === 'dealer' ? 'saffron' : 'muted'}>{buyer.role}</Badge></p>
            <p className="fig text-xs text-muted">{buyer.phone || 'No phone'}{Number(buyer.balance_due) > 0 ? ` · Udhaar ₹${Number(buyer.balance_due).toLocaleString('en-IN')}` : ''}</p>
          </div>
          <button onClick={() => { setBuyer(null); setQ('') }} className="text-muted hover:text-ink" aria-label="Change buyer"><IconX size={18} /></button>
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-line bg-card p-4">
      <div className="mb-1.5 flex items-center justify-between">
        <p className="text-sm font-medium">Buyer</p>
        <button onClick={() => { setAdding((a) => !a); setErr('') }} className="inline-flex items-center gap-1 text-xs font-semibold text-peacock hover:underline">
          <IconUserPlus size={14} /> {adding ? 'Search instead' : 'New buyer'}
        </button>
      </div>

      {adding ? (
        <div className="space-y-2">
          <Field placeholder="Buyer name" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
          <div className="flex gap-2">
            <Field placeholder="Phone (optional)" inputMode="tel" className="flex-1" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} className="ring-focus rounded-md border border-line bg-card px-2 text-sm">
              <option value="customer">Customer</option>
              <option value="dealer">Dealer</option>
            </select>
          </div>
          {err && <p className="text-xs text-dues">{err}</p>}
          <Button onClick={quickAdd} disabled={busy} className="w-full">{busy ? <Spinner /> : 'Add & select'}</Button>
        </div>
      ) : (
        <>
          <input
            value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search customer / dealer by name or phone…"
            className="ring-focus w-full rounded-md border border-line bg-card px-3 py-2.5 text-sm text-ink"
          />
          {rows.length > 0 && (
            <ul className="mt-2 divide-y divide-line overflow-hidden rounded-lg border border-line">
              {rows.map((r) => (
                <li key={r.id}>
                  <button onClick={() => setBuyer(r)} className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-paper-2">
                    <span className="truncate">{r.full_name} <span className="text-xs text-muted">{r.role}</span></span>
                    <span className="fig text-xs text-muted">{r.phone || ''}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}

// ---- Receipt / success screen ------------------------------------------------
function ReceiptScreen({ bill, shop, currency, onNew, home, navigate }) {
  const m = (n) => money(n).replace('₹', currency)
  return (
    <div className="mx-auto max-w-md">
      <div className="no-print rounded-lg border border-line bg-card p-6 text-center">
        <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full bg-profit/10 text-profit"><IconCheck size={26} /></div>
        <p className="text-lg font-bold">Sale complete</p>
        <p className="mt-1 text-sm text-muted">
          Bill <span className="fig">#{bill.bill_id?.slice(0, 8).toUpperCase()}</span> · {bill.lines.length} item{bill.lines.length === 1 ? '' : 's'} · <span className="fig font-semibold text-ink">{m(bill.total)}</span>
        </p>
        {bill.payment_type === 'cash' && bill.tendered != null && (
          <p className="mt-1 fig text-sm">Change due: <span className="font-semibold">{m(Math.max(0, bill.tendered - bill.total))}</span></p>
        )}
        <div className="mt-5 flex gap-2">
          <Button variant="ghost" onClick={() => window.print()} className="flex-1"><IconPrinter size={18} /> Print receipt</Button>
          <Button onClick={onNew} className="flex-1"><IconPlus size={18} /> New sale</Button>
        </div>
        <button onClick={() => navigate(home)} className="mt-3 text-sm text-muted hover:text-ink">Done — back to {home === '/owner' ? 'dashboard' : 'fulfilment'}</button>
      </div>
      <CounterReceipt bill={bill} shop={shop} />
    </div>
  )
}

// ---- small bits --------------------------------------------------------------
function StepBtn({ onClick, children }) {
  return (
    <button onClick={onClick} className="grid h-7 w-7 place-items-center rounded border border-line bg-paper-2 text-ink hover:border-peacock">
      {children}
    </button>
  )
}
function Row({ label, value }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-muted">{label}</span>
      {value}
    </div>
  )
}
