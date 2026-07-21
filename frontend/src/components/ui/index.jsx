// Shared UI primitives — "Counter & Khata" styling (tokens in index.css).
// Big labels, clear focus rings, one obvious primary action per screen (SPEC §3).

import { useState } from 'react'
import { IconPhoto, IconX } from '@tabler/icons-react'

// Tones set the ink colour; the .stamp utility derives its rule + wash from it.
const TONE = {
  peacock: 'text-peacock',
  saffron: 'text-saffron',
  profit: 'text-profit',
  dues: 'text-dues',
  muted: 'text-muted',
}

export function Badge({ tone = 'muted', children, className = '' }) {
  return (
    <span className={`stamp ${TONE[tone] || TONE.muted} ${className}`}>
      {children}
    </span>
  )
}

// Buttons read as pressable counter keys: solid fill, a thin pressed edge
// underneath (inset shadow, not a floaty drop), nudging down on click. Crisp
// 6px radius — one step tighter than a sheet, one looser than a stamp.
const BTN = {
  primary:
    'bg-peacock text-white shadow-[inset_0_-2px_0_var(--color-peacock-700)] hover:bg-peacock-700 hover:shadow-none active:translate-y-px disabled:opacity-60 disabled:shadow-none',
  ghost:
    'bg-card border border-line text-ink hover:border-ink/25 hover:bg-paper-2 active:translate-y-px disabled:opacity-60',
  danger:
    'bg-card border border-dues/40 text-dues hover:bg-dues hover:text-white active:translate-y-px disabled:opacity-60',
  saffron:
    'bg-saffron text-white shadow-[inset_0_-2px_0_color-mix(in_srgb,var(--color-saffron)_70%,#000)] hover:brightness-95 hover:shadow-none active:translate-y-px disabled:opacity-60',
}

export function Button({ variant = 'primary', className = '', type = 'button', ...props }) {
  return (
    <button
      type={type}
      className={`ring-focus inline-flex items-center justify-center gap-2 rounded-md px-4 py-2.5 text-sm font-semibold transition-colors ${BTN[variant]} ${className}`}
      {...props}
    />
  )
}

export function Field({ label, hint, error, prefix, suffix, className = '', ...props }) {
  return (
    <label className="block">
      {label && (
        <span className="mb-1.5 block text-sm font-medium text-ink">{label}</span>
      )}
      <span className="relative flex items-center">
        {prefix && (
          <span className="pointer-events-none absolute left-3 fig text-muted">{prefix}</span>
        )}
        <input
          className={`ring-focus w-full rounded-md border bg-card px-3 py-2.5 text-ink
            ${prefix ? 'pl-7' : ''} ${suffix ? 'pr-9' : ''}
            ${error ? 'border-dues' : 'border-line'} ${className}`}
          {...props}
        />
        {suffix && (
          <span className="pointer-events-none absolute right-3 fig text-muted">{suffix}</span>
        )}
      </span>
      {error ? (
        <span className="mt-1 block text-xs text-dues">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-xs text-muted">{hint}</span>
      ) : null}
    </label>
  )
}

export function Select({ label, hint, error, children, className = '', ...props }) {
  return (
    <label className="block">
      {label && (
        <span className="mb-1.5 block text-sm font-medium text-ink">{label}</span>
      )}
      <select
        className={`ring-focus w-full rounded-md border bg-card px-3 py-2.5 text-ink
          ${error ? 'border-dues' : 'border-line'} ${className}`}
        {...props}
      >
        {children}
      </select>
      {error ? (
        <span className="mt-1 block text-xs text-dues">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-xs text-muted">{hint}</span>
      ) : null}
    </label>
  )
}

export function Textarea({ label, className = '', ...props }) {
  return (
    <label className="block">
      {label && (
        <span className="mb-1.5 block text-sm font-medium text-ink">{label}</span>
      )}
      <textarea
        className={`ring-focus w-full rounded-md border border-line bg-card px-3 py-2.5 text-ink ${className}`}
        {...props}
      />
    </label>
  )
}

// Chip-style tag editor. Type a label and press Enter/comma to add it; Backspace
// on an empty box removes the last chip. value/onChange work on a string[].
export function TagsInput({ label, hint, value = [], onChange, placeholder = 'Type a tag, press Enter' }) {
  const [draft, setDraft] = useState('')
  function add(raw) {
    const t = String(raw).trim()
    if (!t) return
    if (!value.some((x) => x.toLowerCase() === t.toLowerCase())) onChange([...value, t])
    setDraft('')
  }
  function remove(i) { onChange(value.filter((_, idx) => idx !== i)) }
  function onKey(e) {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(draft) }
    else if (e.key === 'Backspace' && !draft && value.length) remove(value.length - 1)
  }
  return (
    <label className="block">
      {label && <span className="mb-1.5 block text-sm font-medium text-ink">{label}</span>}
      <div className="ring-focus flex flex-wrap items-center gap-1.5 rounded-md border border-line bg-card px-2 py-2">
        {value.map((t, i) => (
          <span key={i} className="inline-flex items-center gap-1 rounded bg-peacock/10 px-2 py-1 text-xs font-medium text-peacock">
            {t}
            <button type="button" onClick={() => remove(i)} className="hover:text-peacock-700" aria-label={`Remove ${t}`}>
              <IconX size={12} />
            </button>
          </span>
        ))}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          onBlur={() => add(draft)}
          placeholder={value.length ? '' : placeholder}
          className="min-w-[8rem] flex-1 bg-transparent px-1 py-0.5 text-sm text-ink outline-none"
        />
      </div>
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  )
}

// Multiple image URLs (a gallery). Paste a link and press Enter / tap Add. Each
// added URL shows a thumbnail with a remove button. value/onChange = string[].
export function ImagesInput({ label, hint, value = [], onChange }) {
  const [draft, setDraft] = useState('')
  function add() {
    const u = draft.trim()
    if (!u) return
    if (!value.includes(u)) onChange([...value, u])
    setDraft('')
  }
  function remove(i) { onChange(value.filter((_, idx) => idx !== i)) }
  return (
    <div className="block">
      {label && <span className="mb-1.5 block text-sm font-medium text-ink">{label}</span>}
      {value.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {value.map((u, i) => (
            <div key={i} className="relative h-16 w-16 overflow-hidden rounded-md border border-line bg-paper-2">
              <img src={u} alt="" className="h-full w-full object-cover" onError={(e) => { e.currentTarget.style.opacity = '0.3' }} />
              <button
                type="button" onClick={() => remove(i)} aria-label="Remove image"
                className="absolute right-0.5 top-0.5 rounded bg-ink/60 p-0.5 text-white hover:bg-ink"
              >
                <IconX size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
          placeholder="https://… image URL"
          className="ring-focus w-full rounded-md border border-line bg-card px-3 py-2.5 text-sm text-ink"
        />
        <Button variant="ghost" onClick={add}>Add</Button>
      </div>
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </div>
  )
}

import { stockStatus } from '../../lib/helpers'

export function StockBadge({ quantity, threshold }) {
  const s = stockStatus(quantity, threshold)
  return <Badge tone={s.tone}>{s.label}</Badge>
}

// Order lifecycle (SPEC §7.7). The owner runs the workflow, so they see the
// internal verbs (Pending / Approved / Rejected).
export const ORDER_STATUS = {
  pending:   { label: 'Pending',   tone: 'saffron' },
  approved:  { label: 'Approved',  tone: 'peacock' },
  packed:    { label: 'Packed',    tone: 'peacock' },
  delivered: { label: 'Delivered', tone: 'profit' },
  picked_up: { label: 'Picked up', tone: 'profit' },
  rejected:  { label: 'Rejected',  tone: 'dues' },
}

// Buyer-facing wording — plain language, no shop jargon (SPEC §3). Must read the
// same as the tracking timeline in MyOrderDetail: one state, one name (never
// "Approved" on the badge but "Confirmed by shop" in the progress for the same
// order). "approved" is the shop's word; the buyer hears "Confirmed".
export const ORDER_STATUS_BUYER = {
  pending:   { label: 'Awaiting confirmation', tone: 'saffron' },
  approved:  { label: 'Confirmed',   tone: 'peacock' },
  packed:    { label: 'Packed',      tone: 'peacock' },
  delivered: { label: 'Delivered',   tone: 'profit' },
  picked_up: { label: 'Picked up',   tone: 'profit' },
  rejected:  { label: 'Not accepted', tone: 'dues' },
}

export function OrderStatusBadge({ status, audience = 'owner' }) {
  const map = audience === 'buyer' ? ORDER_STATUS_BUYER : ORDER_STATUS
  const s = map[status] || { label: status, tone: 'muted' }
  return <Badge tone={s.tone}>{s.label}</Badge>
}

// Sale recorded, fulfilment underway — not yet delivered/picked up. The owner
// uses this to spot orders still being worked at a glance.
export const IN_PROCESS_STATUSES = ['approved', 'packed']

// "In process" stamp for orders mid-fulfilment (owner side). A steady inked dot,
// not a radar ping — the realtime list already moves on its own.
export function InProcessBadge({ className = '' }) {
  return (
    <span className={`stamp text-peacock ${className}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-peacock" />
      In process
    </span>
  )
}

export function Spinner({ className = '' }) {
  return (
    <span
      className={`inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent ${className}`}
      aria-hidden
    />
  )
}

// Product thumbnail with a built-in click-to-zoom lightbox. Drop-in replacement
// for the per-page <Thumb url={...}/>. Manages its own overlay state, so callers
// just pass the photo URL (and optionally a size class). Anchor-safe: the trigger
// is a span (not a button) and all clicks preventDefault + stopPropagation, so it
// works inside a clickable <Link> row without navigating or nesting <button> in <a>.
export function PhotoThumb({ url, size = 'h-14 w-14', alt = '' }) {
  const [open, setOpen] = useState(false)
  const stop = (e) => { e.preventDefault(); e.stopPropagation() }
  if (!url) {
    return (
      <div className={`grid ${size} shrink-0 place-items-center rounded-lg border border-line bg-paper-2 text-muted`}>
        <IconPhoto size={22} />
      </div>
    )
  }
  return (
    <>
      <span
        role="button"
        tabIndex={0}
        title="View photo"
        onClick={(e) => { stop(e); setOpen(true) }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { stop(e); setOpen(true) } }}
        className={`group ${size} block shrink-0 cursor-pointer overflow-hidden rounded-md border border-line bg-paper-2 transition-colors hover:border-peacock`}
      >
        <img src={url} alt={alt} className="h-full w-full object-cover transition group-hover:scale-105" />
      </span>
      {open && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-ink/70 p-4" onClick={(e) => { stop(e); setOpen(false) }}>
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => { stop(e); setOpen(false) }}
            className="absolute right-4 top-4 cursor-pointer rounded-lg bg-card/90 p-2 text-ink hover:bg-card"
          >
            <IconX size={22} />
          </span>
          <img
            src={url}
            alt={alt}
            onClick={stop}
            className="max-h-[85vh] max-w-full rounded-lg border border-line object-contain shadow-2xl"
          />
        </div>
      )}
    </>
  )
}
