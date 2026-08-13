// Rules for correcting a purchase bill (migration 039).
// Run with:  node --test src/lib/purchaseEdit.test.mjs
//
// The first case here is the crash that shipped: a brand-new product added to a
// bill has no `item` yet, was mistaken for a product deleted from the catalogue,
// and the error message then read `.name` off nothing. A build cannot catch
// that — it only ever ran inside a click handler.
import test from 'node:test'
import assert from 'node:assert/strict'
import { orphanLines, stockShortfalls, costRateChanges, billEditProblem } from './purchaseEdit.js'

const existing = (id, itemId, quantity, rate, extra = {}) => ({
  mode: 'existing',
  rowId: id,
  item: { id: itemId, name: `Item ${itemId}`, purchase_rate: rate, ...extra },
  quantity: String(quantity),
  purchase_rate: String(rate),
})
const brandNew = (name, quantity, rate) => ({
  mode: 'new', name, quantity: String(quantity), purchase_rate: String(rate),
})
const deleted = (id) => ({
  mode: 'existing', rowId: id, item: { id: null, name: 'Deleted product' },
  quantity: '5', purchase_rate: '10',
})

test('a brand-new product is not an orphan — it has no item until it is saved', () => {
  assert.deepEqual(orphanLines([brandNew('Rakhi Box', 10, 25)]), [])
  assert.equal(billEditProblem({ lines: [brandNew('Rakhi Box', 10, 25)], shortfalls: [] }), '')
})

test('a product deleted from the catalogue is an orphan, and is named', () => {
  const lines = [existing('r1', 'a', 5, 10), deleted('r2')]
  assert.equal(orphanLines(lines).length, 1)
  const msg = billEditProblem({ lines, shortfalls: [] })
  assert.match(msg, /"Deleted product" was deleted from your catalogue/)
})

test('an orphan with no item at all still produces a message, never a crash', () => {
  const lines = [{ mode: 'existing', rowId: 'r1', quantity: '1', purchase_rate: '1' }]
  assert.equal(orphanLines(lines).length, 1)
  assert.match(billEditProblem({ lines, shortfalls: [] }), /A product on this bill/)
})

test('an empty bill is refused', () => {
  assert.match(billEditProblem({ lines: [], shortfalls: [] }), /at least one product/)
})

test('cutting a line below what is already sold is a shortfall', () => {
  // Bill had 100; 60 sold, so 40 on hand. Cutting to 30 would need 70 back.
  const short = stockShortfalls({
    originalLines: [existing('r1', 'a', 100, 10)],
    lines: [existing('r1', 'a', 30, 10)],
    onHand: new Map([['a', { name: 'Item a', quantity: 40 }]]),
  })
  assert.equal(short.length, 1)
  assert.equal(short[0].short, 30)
  assert.match(
    billEditProblem({ lines: [existing('r1', 'a', 30, 10)], shortfalls: short }),
    /short by 30 pcs/,
  )
})

test('cutting only as far as stock allows is fine', () => {
  const short = stockShortfalls({
    originalLines: [existing('r1', 'a', 100, 10)],
    lines: [existing('r1', 'a', 60, 10)],
    onHand: new Map([['a', { name: 'Item a', quantity: 40 }]]),
  })
  assert.deepEqual(short, [])
})

test('moving pcs between two lines of the same product is not a shortfall', () => {
  const short = stockShortfalls({
    originalLines: [existing('r1', 'a', 100, 10)],
    lines: [existing('r1', 'a', 40, 10), existing(null, 'a', 60, 10)],
    onHand: new Map([['a', { name: 'Item a', quantity: 0 }]]),
  })
  assert.deepEqual(short, [])
})

test('removing a line entirely gives its stock back, and can be short', () => {
  const short = stockShortfalls({
    originalLines: [existing('r1', 'a', 50, 10)],
    lines: [],
    onHand: new Map([['a', { name: 'Item a', quantity: 40 }]]),
  })
  assert.equal(short.length, 1)
  assert.equal(short[0].short, 10)
})

test('adding stock is never a shortfall, whatever is on hand', () => {
  const short = stockShortfalls({
    originalLines: [existing('r1', 'a', 10, 10)],
    lines: [existing('r1', 'a', 999, 10), brandNew('Fresh', 5, 2)],
    onHand: new Map([['a', { name: 'Item a', quantity: 0 }]]),
  })
  assert.deepEqual(short, [])
})

test('a changed cost rate is reported once per product, with both figures', () => {
  const changes = costRateChanges([existing('r1', 'a', 5, 12, { purchase_rate: 10 })])
  assert.deepEqual(changes, [{ id: 'a', name: 'Item a', from: 10, to: 12 }])
})

test('an unchanged cost rate is not reported, and a new product never is', () => {
  assert.deepEqual(costRateChanges([existing('r1', 'a', 5, 10, { purchase_rate: 10 })]), [])
  assert.deepEqual(costRateChanges([brandNew('Rakhi Box', 10, 25)]), [])
})
