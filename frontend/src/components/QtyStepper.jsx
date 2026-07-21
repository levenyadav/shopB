import { useEffect, useRef, useState } from 'react'
import { IconMinus, IconPlus } from '@tabler/icons-react'
import { snapToMoq } from '../lib/helpers'

// Quantity control for the storefront (item detail + cart). − / + step by one
// MOQ, and the number itself can be typed. Typing is left alone while the field
// has focus — snapping every keystroke makes a pack of 50 impossible to type,
// because "5" would jump to 50 before the "0" arrives. The typed value is
// snapped to a whole multiple of MOQ on blur or Enter (Golden Rule: a buyer can
// never order a partial pack), and we say so when the number had to move.
//
// cap = Infinity for made-to-order items (no stock ceiling); otherwise stock.
export default function QtyStepper({
  value, moq, cap = Infinity, onChange, disabled = false, size = 'md',
}) {
  const step = Math.max(1, Number(moq) || 1)
  const [draft, setDraft] = useState(String(value))
  const [typing, setTyping] = useState(false)
  const [snapped, setSnapped] = useState(null) // what the buyer typed, if we moved it
  const timer = useRef(null)

  // Follow the committed value whenever it changes from outside (− / + buttons,
  // cart state), but never yank the text out from under someone mid-type.
  useEffect(() => {
    if (!typing) setDraft(String(value))
  }, [value, typing])

  useEffect(() => () => clearTimeout(timer.current), [])

  function commit() {
    setTyping(false)
    const typed = Number(draft)
    // Empty or junk → put the last good quantity back, no scolding.
    if (!draft.trim() || !Number.isFinite(typed) || typed <= 0) {
      setDraft(String(value))
      return
    }
    const next = snapToMoq(typed, step, cap)
    setDraft(String(next))
    if (next !== typed) {
      setSnapped(typed)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setSnapped(null), 4000)
    } else {
      setSnapped(null)
    }
    if (next !== value) onChange(next)
  }

  const sm = size === 'sm'
  const btn = `grid place-items-center text-muted hover:text-ink disabled:opacity-40 ${sm ? 'h-8 w-8' : 'h-10 w-10'}`

  return (
    <div>
      <div className="inline-flex items-center rounded-lg border border-line">
        <button type="button" disabled={disabled} aria-label={`Less ${step}`}
                onClick={() => onChange(snapToMoq(value - step, step, cap))}
                className={btn}>
          <IconMinus size={sm ? 16 : 18} />
        </button>
        <input
          type="text" inputMode="numeric" value={draft} disabled={disabled}
          aria-label="Quantity"
          onChange={(e) => { setTyping(true); setDraft(e.target.value.replace(/[^\d]/g, '')) }}
          onFocus={(e) => { setTyping(true); e.target.select() }}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur() } }}
          className={`fig border-x border-line text-center outline-none ${sm ? 'w-12 py-1.5 text-sm' : 'w-14 py-2'}`}
        />
        <button type="button" disabled={disabled} aria-label={`More ${step}`}
                onClick={() => onChange(snapToMoq(value + step, step, cap))}
                className={btn}>
          <IconPlus size={sm ? 16 : 18} />
        </button>
      </div>
      {snapped !== null && (
        <p className={`mt-1 text-saffron ${sm ? 'text-xs' : 'text-sm'}`}>
          Sold in packs of <span className="fig">{step}</span> — changed{' '}
          <span className="fig">{snapped}</span> to <span className="fig">{draft}</span>.
        </p>
      )}
    </div>
  )
}
