import { useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'

// A filter value kept in the URL (?key=value) instead of component state, so
// Back from a detail page lands on the same filtered list, and other screens
// can link straight to a filtered view (Dashboard → "low stock" → ?low=1).
// Setting the fallback (or '') removes the key; history is replaced, not
// pushed, so flipping filters never piles up Back steps.
//
// Only for pickers/toggles. Free-text search stays in local state: a
// URL-driven text box drops keystrokes (the router update lands a render late).
export default function useQueryState(key, fallback = '') {
  const [params, setParams] = useSearchParams()
  const value = params.get(key) ?? fallback
  const set = useCallback((v) => {
    setParams((p) => {
      const n = new URLSearchParams(p)
      if (v === '' || v === null || v === undefined || v === fallback) n.delete(key)
      else n.set(key, String(v))
      return n
    }, { replace: true })
  }, [key, fallback, setParams])
  return [value, set]
}
