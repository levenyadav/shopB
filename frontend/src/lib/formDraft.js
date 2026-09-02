// Autosaved form drafts (localStorage). Survives a refresh, an accidental
// back-swipe, a browser crash and a power cut — long enough for the owner to
// come back and finish a half-typed Purchase Entry / edit instead of starting
// over. One key per form; edit screens append the record id so two records
// never share a draft. Binary (a product photo) can't live here — it goes to
// IndexedDB via lib/idbBlob and is referenced by key from the JSON (see
// PurchaseEntry).
//
// Storage discipline mirrors CartContext: every read/write is wrapped, so a
// dead or full localStorage just means "no draft", never a thrown error.

const PREFIX = 'shopb.draft.'
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000 // a week

export function draftKey(name) {
  return PREFIX + name
}

// Persist `data` (any JSON-serialisable value) under `name`. `version` lets a
// later app build reject a draft written against an incompatible shape.
export function saveDraft(name, data, version = 1) {
  try {
    localStorage.setItem(
      draftKey(name),
      JSON.stringify({ v: version, savedAt: Date.now(), data }),
    )
    return true
  } catch {
    return false
  }
}

// Returns { data, savedAt } or null. A draft that is older than `maxAgeMs`, or
// written by a different schema `version`, is dropped and treated as absent.
export function loadDraft(name, { version = 1, maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
  try {
    const raw = localStorage.getItem(draftKey(name))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || parsed.v !== version || typeof parsed.savedAt !== 'number') {
      clearDraft(name)
      return null
    }
    if (Date.now() - parsed.savedAt > maxAgeMs) {
      clearDraft(name)
      return null
    }
    return { data: parsed.data, savedAt: parsed.savedAt }
  } catch {
    return null
  }
}

export function clearDraft(name) {
  try {
    localStorage.removeItem(draftKey(name))
  } catch {
    /* ignore */
  }
}
