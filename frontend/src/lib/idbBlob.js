// Tiny IndexedDB blob store — just enough to stash a File/Blob out of a form
// draft. localStorage can't hold binary, and base64-in-localStorage is slow and
// eats the ~5 MB budget, so a half-entered Purchase Entry keeps its photo here
// and references it by key from the JSON draft (see lib/formDraft + PurchaseEntry).
//
// Every call is best-effort: a private window, a browser with IndexedDB
// disabled, or a storage error resolves to null / a no-op — the same tolerance
// CartContext has for a dead localStorage. Callers must handle a null blob
// (draft restores without the photo; the owner re-attaches it).

const DB_NAME = 'shopb'
const DB_VERSION = 1
const STORE = 'draft-blobs'

function openDb() {
  return new Promise((resolve) => {
    let req
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION)
    } catch {
      resolve(null)
      return
    }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
    req.onblocked = () => resolve(null)
  })
}

async function withStore(mode, run) {
  const db = await openDb()
  if (!db) return null
  return new Promise((resolve) => {
    let result = null
    let tx
    try {
      tx = db.transaction(STORE, mode)
    } catch {
      db.close()
      resolve(null)
      return
    }
    const req = run(tx.objectStore(STORE))
    if (req) req.onsuccess = () => { result = req.result }
    tx.oncomplete = () => { db.close(); resolve(result) }
    tx.onerror = () => { db.close(); resolve(null) }
    tx.onabort = () => { db.close(); resolve(null) }
  })
}

export function putBlob(key, blob) {
  return withStore('readwrite', (s) => s.put(blob, key))
}

export function getBlob(key) {
  return withStore('readonly', (s) => s.get(key))
}

export function delBlob(key) {
  if (!key) return Promise.resolve(null)
  return withStore('readwrite', (s) => s.delete(key))
}
