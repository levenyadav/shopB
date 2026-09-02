import { useEffect } from 'react'

// Show the browser's native "Leave site? Changes you made may not be saved"
// prompt while `when` is true (the form has unsaved input). Catches an
// accidental Cmd/Ctrl-R or tab close. It does nothing for a power cut — that's
// what the autosaved draft is for — and some mobile browsers ignore it, so it
// is a complement to useFormDraft, never a replacement.
export function useBeforeUnload(when) {
  useEffect(() => {
    if (!when) return
    const handler = (e) => {
      e.preventDefault()
      e.returnValue = '' // required by Chrome to actually show the prompt
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [when])
}
