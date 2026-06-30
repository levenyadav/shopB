import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  IconArrowLeft, IconPhoto, IconMapPin, IconPrinter, IconPackage,
  IconTruckDelivery, IconBuildingStore, IconChecks, IconShare,
} from '@tabler/icons-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import { useShop } from '../../context/ShopContext'
import { qty, dateTime } from '../../lib/format'
import { buildSlipPdf, sharePdf } from '../../lib/pdf'
import { Button, Textarea, Badge, Spinner } from '../../components/ui'
import SupplySlip from '../../components/SupplySlip'
import { FULFIL_STATUS } from './Fulfilment'

// SPEC §6.6 / §13 — one packing job. Staff packs, then owner/staff marks how it
// left (delivered or picked up). Status side-effects (timestamps, order status)
// run in the on_fulfilment_status trigger — the client only sets status + who.
export default function FulfilmentDetail({ listPath }) {
  const { id } = useParams()
  const { profile } = useAuth()
  const { shop } = useShop()
  const [job, setJob] = useState(null)
  const [err, setErr] = useState('')
  const [missing, setMissing] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  async function load() {
    setErr('')
    const { data, error } = await supabase
      .from('fulfilment_queue').select('*').eq('id', id).maybeSingle()
    if (error) setErr(error.message)
    else if (!data) setMissing(true)
    else setJob(data)
  }
  useEffect(() => { load() }, [id])

  async function setStatus(status) {
    setBusy(true); setErr('')
    const patch = { status }
    if (status === 'packed') patch.packed_by = profile.id
    else { patch.completed_by = profile.id; if (note.trim()) patch.delivery_note = note.trim() }
    const { error } = await supabase.from('fulfilment').update(patch).eq('id', job.id)
    setBusy(false)
    if (error) { setErr(error.message); return }
    load()
  }

  if (missing) return <Empty>Job not found. <Link to={listPath} className="font-medium text-peacock hover:underline">Back to fulfilment</Link>.</Empty>
  if (err && !job) return <Empty>{err}</Empty>
  if (!job) return <div className="grid place-items-center py-20 text-muted"><Spinner /></div>

  const meta = FULFIL_STATUS[job.status] || { label: job.status, tone: 'muted' }
  const isDone = job.status === 'delivered' || job.status === 'picked_up'

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <Link to={listPath} className="no-print inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-ink">
        <IconArrowLeft size={17} /> All fulfilment
      </Link>

      {/* Job summary */}
      <div className="rounded-lg border border-line bg-card p-5">
        <div className="flex items-center gap-4">
          <Thumb url={job.photo_url} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-lg font-semibold">{job.item_name || 'Item'}</p>
            <p className="text-xs text-muted">Order placed {dateTime(job.ordered_at)}</p>
          </div>
          <Badge tone={meta.tone}>{meta.label}</Badge>
        </div>

        <dl className="mt-5 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          <Row label="Buyer" value={<>{job.buyer_name || '—'} <Badge tone={job.buyer_type === 'dealer' ? 'peacock' : 'muted'} className="ml-1">{job.buyer_type}</Badge></>} />
          <Row label="Phone" value={<span className="fig">{job.buyer_phone || '—'}</span>} />
          <Row label="Item No" value={<span className="fig">{job.item_no || '—'}</span>} />
          <Row label="Location / Rack" value={<span className="inline-flex items-center gap-1">{job.location ? <><IconMapPin size={15} /> {job.location}</> : '—'}</span>} />
          <Row label="Quantity" value={<span className="fig font-semibold">{qty(job.quantity)} pcs</span>} />
          {job.notes && <Row label="Buyer note" value={job.notes} full />}
        </dl>

        {(job.packed_at || job.completed_at) && (
          <div className="mt-4 flex flex-wrap gap-x-6 gap-y-1 rounded-lg bg-paper-2 px-4 py-3 text-xs text-muted">
            {job.packed_at && <span>Packed {dateTime(job.packed_at)}</span>}
            {job.completed_at && <span>Completed {dateTime(job.completed_at)}</span>}
            {job.delivery_note && <span>Note: {job.delivery_note}</span>}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="no-print space-y-4">
        {err && job && <p className="rounded-lg bg-dues/10 px-4 py-3 text-sm text-dues">{err}</p>}

        {job.status === 'pending_pack' && (
          <div className="rounded-lg border border-line bg-card p-5">
            <p className="mb-1 font-semibold">Pack this order</p>
            <p className="mb-4 text-sm text-muted">
              Pull <span className="fig font-medium text-ink">{qty(job.quantity)}</span> pcs of{' '}
              <span className="font-medium text-ink">{job.item_name}</span>
              {job.location && <> from <span className="font-medium text-ink">{job.location}</span></>}, then mark it packed.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button onClick={() => setStatus('packed')} disabled={busy} className="flex-1">
                {busy ? <><Spinner /> Saving…</> : <><IconPackage size={18} /> Mark as Packed</>}
              </Button>
              <PrintButton job={job} shop={shop} />
            </div>
          </div>
        )}

        {job.status === 'packed' && (
          <div className="rounded-lg border border-line bg-card p-5">
            <p className="mb-1 font-semibold">How did it leave the shop?</p>
            <p className="mb-4 text-sm text-muted">Choose delivered (sent out) or picked up (collected at the counter).</p>
            <Textarea
              label="Delivery note (optional)" rows={2} value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. handed to Ramesh, left at front desk…"
            />
            <div className="mt-3 flex flex-wrap gap-3">
              <Button onClick={() => setStatus('delivered')} disabled={busy} className="flex-1">
                <IconTruckDelivery size={18} /> Delivered
              </Button>
              <Button variant="ghost" onClick={() => setStatus('picked_up')} disabled={busy} className="flex-1">
                <IconBuildingStore size={18} /> Picked up
              </Button>
              <PrintButton job={job} shop={shop} />
            </div>
          </div>
        )}

        {isDone && (
          <div className="rounded-lg border border-profit/30 bg-profit/10 p-5">
            <div className="flex items-center gap-2 text-profit">
              <IconChecks size={20} />
              <p className="font-semibold">
                {job.status === 'delivered' ? 'Delivered' : 'Picked up'} — order complete
              </p>
            </div>
            <div className="mt-3"><PrintButton label="Reprint slip" job={job} shop={shop} /></div>
          </div>
        )}
      </div>

      {/* Hidden on screen; the only thing inked when printing (SPEC §13). */}
      <SupplySlip job={job} shop={shop} />
    </div>
  )
}

function PrintButton({ label = 'Print supply slip', job, shop }) {
  const ref = job?.order_id?.slice(0, 8).toUpperCase()
  return (
    <>
      <Button variant="ghost" onClick={() => window.print()}>
        <IconPrinter size={18} /> {label}
      </Button>
      {job && (
        <Button variant="ghost" onClick={() => sharePdf(buildSlipPdf(job, shop), `supply-slip-${ref}.pdf`, `Supply slip #${ref}`)}>
          <IconShare size={18} /> Share slip
        </Button>
      )}
    </>
  )
}

function Row({ label, value, full }) {
  return (
    <div className={full ? 'col-span-2 sm:col-span-3' : ''}>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-ink">{value}</dd>
    </div>
  )
}

function Thumb({ url }) {
  return (
    <div className="h-14 w-14 shrink-0 overflow-hidden rounded-lg border border-line bg-paper-2">
      {url ? <img src={url} alt="" className="h-full w-full object-cover" />
           : <div className="grid h-full w-full place-items-center text-muted"><IconPhoto size={22} /></div>}
    </div>
  )
}

function Empty({ children }) {
  return <div className="mx-auto max-w-md rounded-lg border border-dashed border-line p-10 text-center text-muted">{children}</div>
}
