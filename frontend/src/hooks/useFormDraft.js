import { useEffect, useRef, useState } from 'react'
import { saveDraft, loadDraft, clearDraft } from '../lib/formDraft'

// Auto-restore + debounced autosave for one form.
//
//   const { restoredAt, clear } = useFormDraft({
//     name: 'purchaseEntry.bill',
//     value: { bill, lines },
//     isEmpty: (v) => !v.bill.supplier_id && v.lines.length === 0,
//     serialize: async (v) => ({ ...v, lines: await stashPhotos(v.lines) }),
//     onRestore: async (data) => { setBill(data.bill); setLines(await rebuild(data.lines)) },
//   })
//
// On mount it reads any saved draft and hands it to `onRestore` (decision:
// auto-restore, with a "Start fresh" escape hatch the caller renders from
// `restoredAt`). After that, every change to `value` is saved ~`debounceMs`
// later. `isEmpty(value)` stops a blank form from writing noise. `serialize`
// and `onRestore` may be async (needed when a photo has to move to/from
// IndexedDB). The hook never auto-deletes a draft on its own — only `clear()`,
// which the caller calls on a successful submit or "Start fresh".
export function useFormDraft({
  name,
  value,
  isEmpty,
  onRestore,
  serialize = (v) => v,
  version = 1,
  debounceMs = 800,
  maxAgeMs,
  enabled = true,
}) {
  const [restoredAt, setRestoredAt] = useState(null)
  const mounted = useRef(false)

  // Keep the latest callbacks without making the effects depend on them.
  const cbs = useRef({ isEmpty, onRestore, serialize })
  cbs.current = { isEmpty, onRestore, serialize }

  // Restore once, on mount.
  useEffect(() => {
    if (!enabled) return
    const found = loadDraft(name, { version, maxAgeMs })
    if (!found || found.data == null) return
    Promise.resolve(cbs.current.onRestore?.(found.data))
      .catch(() => {})
      .finally(() => setRestoredAt(found.savedAt))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, enabled])

  // Debounced save on every change. The first (mount) pass is skipped so a
  // freshly restored value isn't immediately rewritten as a partial.
  useEffect(() => {
    if (!enabled) return
    if (!mounted.current) { mounted.current = true; return }
    if (cbs.current.isEmpty?.(value)) return
    const id = setTimeout(() => {
      Promise.resolve(cbs.current.serialize(value))
        .then((data) => { if (data != null) saveDraft(name, data, version) })
        .catch(() => {})
    }, debounceMs)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, enabled])

  const clear = () => {
    clearDraft(name)
    setRestoredAt(null)
  }

  return { restoredAt, clear }
}
