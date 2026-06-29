// Shared UI primitives — "Counter & Khata" styling (tokens in index.css).
// Big labels, clear focus rings, one obvious primary action per screen (SPEC §3).

const TONES = {
  peacock: 'bg-peacock/10 text-peacock',
  saffron: 'bg-saffron/15 text-saffron',
  profit: 'bg-profit/10 text-profit',
  dues: 'bg-dues/10 text-dues',
  muted: 'bg-paper-2 text-muted',
}

export function Badge({ tone = 'muted', children, className = '' }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${TONES[tone] || TONES.muted} ${className}`}
    >
      {children}
    </span>
  )
}

const BTN = {
  primary:
    'bg-peacock hover:bg-peacock-700 text-white shadow-sm disabled:opacity-60',
  ghost:
    'bg-card border border-line text-ink hover:bg-paper-2 disabled:opacity-60',
  danger:
    'bg-dues/10 border border-dues/30 text-dues hover:bg-dues/20 disabled:opacity-60',
  saffron:
    'bg-saffron hover:brightness-95 text-white shadow-sm disabled:opacity-60',
}

export function Button({ variant = 'primary', className = '', type = 'button', ...props }) {
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition ${BTN[variant]} ${className}`}
      {...props}
    />
  )
}

export function Field({ label, hint, error, prefix, className = '', ...props }) {
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
          className={`w-full rounded-lg border bg-card px-3 py-2.5 text-ink outline-none transition
            focus:border-peacock focus:ring-2 focus:ring-peacock/25
            ${prefix ? 'pl-7' : ''}
            ${error ? 'border-dues' : 'border-line'} ${className}`}
          {...props}
        />
      </span>
      {error ? (
        <span className="mt-1 block text-xs text-dues">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-xs text-muted">{hint}</span>
      ) : null}
    </label>
  )
}

export function Select({ label, error, children, className = '', ...props }) {
  return (
    <label className="block">
      {label && (
        <span className="mb-1.5 block text-sm font-medium text-ink">{label}</span>
      )}
      <select
        className={`w-full rounded-lg border bg-card px-3 py-2.5 text-ink outline-none transition
          focus:border-peacock focus:ring-2 focus:ring-peacock/25
          ${error ? 'border-dues' : 'border-line'} ${className}`}
        {...props}
      >
        {children}
      </select>
      {error && <span className="mt-1 block text-xs text-dues">{error}</span>}
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
        className={`w-full rounded-lg border border-line bg-card px-3 py-2.5 text-ink outline-none transition
          focus:border-peacock focus:ring-2 focus:ring-peacock/25 ${className}`}
        {...props}
      />
    </label>
  )
}

import { stockStatus } from '../../lib/helpers'

export function StockBadge({ quantity, threshold }) {
  const s = stockStatus(quantity, threshold)
  return <Badge tone={s.tone}>{s.label}</Badge>
}

// Order lifecycle (SPEC §7.7). Shared by buyer tracking and owner management.
export const ORDER_STATUS = {
  pending:   { label: 'Pending',   tone: 'saffron' },
  approved:  { label: 'Approved',  tone: 'peacock' },
  packed:    { label: 'Packed',    tone: 'peacock' },
  delivered: { label: 'Delivered', tone: 'profit' },
  picked_up: { label: 'Picked up', tone: 'profit' },
  rejected:  { label: 'Rejected',  tone: 'dues' },
}

export function OrderStatusBadge({ status }) {
  const s = ORDER_STATUS[status] || { label: status, tone: 'muted' }
  return <Badge tone={s.tone}>{s.label}</Badge>
}

export function Spinner({ className = '' }) {
  return (
    <span
      className={`inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent ${className}`}
      aria-hidden
    />
  )
}
