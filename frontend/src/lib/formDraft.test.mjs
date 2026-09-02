import { test } from 'node:test'
import assert from 'node:assert/strict'

// Minimal in-memory localStorage so the module under test can run in node.
class MemStore {
  #m = new Map()
  getItem(k) { return this.#m.has(k) ? this.#m.get(k) : null }
  setItem(k, v) { this.#m.set(k, String(v)) }
  removeItem(k) { this.#m.delete(k) }
  clear() { this.#m.clear() }
}
globalThis.localStorage = new MemStore()

const { saveDraft, loadDraft, clearDraft, draftKey } = await import('./formDraft.js')

test('save then load round-trips the data', () => {
  localStorage.clear()
  saveDraft('purchaseEntry.bill', { supplier_id: 'abc', lines: [{ qty: 2 }] })
  const got = loadDraft('purchaseEntry.bill')
  assert.equal(got.data.supplier_id, 'abc')
  assert.equal(got.data.lines[0].qty, 2)
  assert.equal(typeof got.savedAt, 'number')
})

test('load returns null when nothing is stored', () => {
  localStorage.clear()
  assert.equal(loadDraft('nope'), null)
})

test('clearDraft removes the entry', () => {
  localStorage.clear()
  saveDraft('x', { a: 1 })
  clearDraft('x')
  assert.equal(loadDraft('x'), null)
})

test('a draft older than maxAgeMs is dropped', () => {
  localStorage.clear()
  const stale = JSON.stringify({ v: 1, savedAt: Date.now() - 60_000, data: { a: 1 } })
  localStorage.setItem(draftKey('old'), stale)
  assert.equal(loadDraft('old', { maxAgeMs: 1000 }), null)
  // and it was cleaned up, not left to rot
  assert.equal(localStorage.getItem(draftKey('old')), null)
})

test('a draft from a different schema version is rejected', () => {
  localStorage.clear()
  localStorage.setItem(draftKey('v'), JSON.stringify({ v: 1, savedAt: Date.now(), data: { a: 1 } }))
  assert.equal(loadDraft('v', { version: 2 }), null)
})

test('corrupt JSON is treated as no draft', () => {
  localStorage.clear()
  localStorage.setItem(draftKey('bad'), '{not json')
  assert.equal(loadDraft('bad'), null)
})

test('saveDraft swallows a throwing localStorage', () => {
  const real = globalThis.localStorage
  globalThis.localStorage = { setItem() { throw new Error('quota') }, getItem() { return null }, removeItem() {} }
  assert.equal(saveDraft('q', { a: 1 }), false)
  globalThis.localStorage = real
})
