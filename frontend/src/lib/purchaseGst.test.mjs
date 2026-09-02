// Suggested GST on a supplier bill (migration 036 + this fix).
// Run with:  node --test src/lib/purchaseGst.test.mjs
//
// The bug this guards: the suggestion taxed goods only, so a bill with
// supplier-charged freight came out short by (gst_rate x freight). A real
// paper bill for 800 wedding cards — goods 10,000, transport 100 — was taxed
// by the supplier on 10,100 (IGST 1,818, total 11,918); the app suggested
// 1,800 and showed 11,900. Freight is part of the taxable value
// (CGST Act §15(2)(c)); it still never touches product cost.
import test from 'node:test'
import assert from 'node:assert/strict'
import { suggestPurchaseGst } from './helpers.js'

test('freight on the bill is taxed with the goods — matches the supplier invoice', () => {
  const s = suggestPurchaseGst([{ amount: 10000, rate: 18 }], 100)
  assert.deepEqual(s, { tax: 1818, cgst: 909, sgst: 909 })
})

test('no freight leaves the old figure untouched', () => {
  const s = suggestPurchaseGst([{ amount: 10000, rate: 18 }])
  assert.deepEqual(s, { tax: 1800, cgst: 900, sgst: 900 })
})

test('freight is apportioned across slabs by line value', () => {
  // 200 freight splits 100/100; 5100 @ 12% + 5100 @ 18% = 612 + 918
  const s = suggestPurchaseGst([{ amount: 5000, rate: 12 }, { amount: 5000, rate: 18 }], 200)
  assert.deepEqual(s, { tax: 1530, cgst: 765, sgst: 765 })
})

test('nil-rated goods have no slab to attach freight to — no suggestion', () => {
  assert.equal(suggestPurchaseGst([{ amount: 10000, rate: 0 }], 100), null)
})

test('missing / blank postage is treated as zero', () => {
  assert.deepEqual(suggestPurchaseGst([{ amount: 10000, rate: 18 }], ''), {
    tax: 1800, cgst: 900, sgst: 900,
  })
})
