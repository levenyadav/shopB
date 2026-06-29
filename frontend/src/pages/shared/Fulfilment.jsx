import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  IconPhoto, IconPackage, IconTruckDelivery, IconChecks, IconMapPin,
} from '@tabler/icons-react'
import { supabase } from '../../lib/supabase'
import { qty, dateTime } from '../../lib/format'
import { Badge, Spinner } from '../../components/ui'

// SPEC §6.6 — Fulfilment board. Approved orders land here as packing jobs. Two
// active buckets: to-pack, then packed-awaiting-handover; completed jobs drop to
// history. Read from the fulfilment_queue view (008) so it works for staff too —
// staff can't read profiles/sales directly, the view exposes only safe columns.
export const FULFIL_STATUS = {
  pending_pack: { label: 'To pack',   tone: 'saffron', icon: IconPackage },
  packed:       { label: 'Packed',    tone: 'peacock', icon: IconTruckDelivery },
  delivered:    { label: 'Delivered', tone: 'profit',  icon: IconChecks },
  picked_up:    { label: 'Picked up', tone: 'profit',  icon: IconChecks },
}

export default function Fulfilment({ detailBase }) {
  const [jobs, setJobs] = useState(null)
  const [err, setErr] = useState('')
  const [showDone, setShowDone] = useState(false)

  async function load() {
    setErr('')
    const { data, error } = await supabase
      .from('fulfilment_queue')
      .select('*')
      .order('created_at', { ascending: true })
    if (error) setErr(error.message)
    else setJobs(data ?? [])
  }

  useEffect(() => {
    load()
    // Live board: any fulfilment change (new job, pack, deliver) refetches.
    const channel = supabase
      .channel('fulfilment-board')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'fulfilment' }, load)
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [])

  const { toPack, packed, done } = useMemo(() => {
    const j = jobs ?? []
    return {
      toPack: j.filter((x) => x.status === 'pending_pack'),
      packed: j.filter((x) => x.status === 'packed'),
      done: j.filter((x) => x.status === 'delivered' || x.status === 'picked_up')
             .sort((a, b) => (b.completed_at || '').localeCompare(a.completed_at || '')),
    }
  }, [jobs])

  if (jobs === null) return <div className="grid place-items-center py-20 text-muted"><Spinner /></div>

  return (
    <div className="space-y-6">
      {err && <p className="rounded-lg bg-dues/10 px-4 py-3 text-sm text-dues">{err}</p>}

      <Section
        title="Waiting to pack" count={toPack.length} tone="saffron"
        empty="Nothing waiting. New approved orders show up here to pack."
      >
        {toPack.map((j) => <JobCard key={j.id} job={j} detailBase={detailBase} />)}
      </Section>

      <Section
        title="Packed — hand over" count={packed.length} tone="peacock"
        empty="No packed orders waiting for delivery or pickup."
      >
        {packed.map((j) => <JobCard key={j.id} job={j} detailBase={detailBase} />)}
      </Section>

      {done.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowDone((v) => !v)}
            className="text-sm font-medium text-muted hover:text-ink"
          >
            {showDone ? 'Hide' : 'Show'} completed ({done.length})
          </button>
          {showDone && (
            <ul className="mt-3 space-y-2.5">
              {done.map((j) => <JobCard key={j.id} job={j} detailBase={detailBase} />)}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function Section({ title, count, tone, empty, children }) {
  const items = Array.isArray(children) ? children.filter(Boolean) : children
  const isEmpty = !items || (Array.isArray(items) && items.length === 0)
  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <h2 className="font-[var(--font-display)] text-lg font-bold">{title}</h2>
        <Badge tone={tone}>{count}</Badge>
      </div>
      {isEmpty ? (
        <p className="rounded-2xl border border-dashed border-line bg-paper-2 px-5 py-8 text-center text-sm text-muted">
          {empty}
        </p>
      ) : (
        <ul className="space-y-2.5">{items}</ul>
      )}
    </section>
  )
}

function JobCard({ job, detailBase }) {
  const meta = FULFIL_STATUS[job.status] || { label: job.status, tone: 'muted' }
  return (
    <li>
      <Link
        to={`${detailBase}/${job.id}`}
        className="flex items-center gap-4 rounded-xl border border-line bg-card p-3 transition hover:shadow-sm"
      >
        <Thumb url={job.photo_url} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-ink">{job.item_name || 'Item'}</p>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted">
            <span>{job.buyer_name || 'Buyer'}</span>
            {job.location && (
              <span className="inline-flex items-center gap-1">
                <IconMapPin size={13} /> {job.location}
              </span>
            )}
            <span>{dateTime(job.ordered_at)}</span>
          </p>
        </div>
        <div className="text-right">
          <p className="fig font-semibold">{qty(job.quantity)} pcs</p>
        </div>
        <Badge tone={meta.tone}>{meta.label}</Badge>
      </Link>
    </li>
  )
}

function Thumb({ url }) {
  return (
    <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg border border-line bg-paper-2">
      {url ? <img src={url} alt="" className="h-full w-full object-cover" />
           : <div className="grid h-full w-full place-items-center text-muted"><IconPhoto size={20} /></div>}
    </div>
  )
}
