import JsBarcode from 'jsbarcode'

// Barcode label printing (SPEC §6.2 — Inventory). Renders real Code128 barcodes
// and prints them as 33mm × 20mm labels, laid out 3-per-row for a thermal label
// printer. Prints via a hidden iframe so no popup-blocker gets in the way.
//
// Geometry MUST match the physical die-cut roll and the TSC TTP-244 Pro driver
// (media = Gap sensor, left/top margin 0). Roll spec (measured):
//   Label 33mm × 20mm · Horizontal gap ~0.1mm · Vertical gap ~2.7mm · 3 columns
//   Total media width = 33 + 0.1 + 33 + 0.1 + 33 = 99.2mm
// If the cell size / gaps here don't match the roll, content drifts across the
// row and down the columns (each label creeps off its sticker) — do not change
// these numbers unless the physical stock changes.
const LABEL_W = '33mm'    // physical label width
const LABEL_H = '20mm'    // physical label height
const COL_GAP = '0.1mm'   // horizontal gap, column → column
const COLS = 3            // labels across the roll
const SHEET_W = '99.2mm'  // 33·3 + 0.1·2 — the full media width
// Vertical die gap is ~2.7mm — NOT set in CSS. Each row prints as its own
// one-label-tall page and the printer's gap sensor advances that gap itself.

// What we encode: the item's barcode if set, else its Item No as a fallback so
// every item is printable. Code128 handles alphanumeric Item Nos fine.
export function barcodeValue(item) {
  return String(item?.barcode || item?.item_no || '').trim()
}

// Render one Code128 barcode to an inline <svg> string.
function barcodeSvg(value) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  JsBarcode(svg, value, {
    format: 'CODE128',
    width: 1.5, // bar thickness; svg scales to the label anyway
    height: 50,
    displayValue: false, // we print our own, smaller code text below
    margin: 0,
  })
  // JsBarcode sets a viewBox but leaves the default preserveAspectRatio
  // ("xMidYMid meet"), which locks the aspect ratio and letterboxes the
  // barcode inside .bc instead of filling it — the printed bars end up
  // smaller than the cell and don't reach the label edges. "none" stretches
  // both axes independently to fill the cell exactly; this is safe for
  // Code128 because a scanner only reads relative bar widths along one axis
  // — uniform horizontal scaling preserves those ratios, and vertical
  // stretch only changes bar height, which never affects decodability.
  svg.setAttribute('preserveAspectRatio', 'none')
  return new XMLSerializer().serializeToString(svg)
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}

// Which rate (if any) to print, and where to read it from on the item.
function rateText(item, currency, rate) {
  const field = rate === 'customer' ? 'rate' : rate === 'dealer' ? 'dealer_rate' : null
  if (!field || item[field] == null) return ''
  return `${currency}${item[field]}`
}

// `opts` chooses what each label shows (see DEFAULT_LABEL_OPTS). The shop name,
// item code, and rate can each be turned off; rate is one-at-a-time (customer
// OR dealer). Item name is off by default but available as an option.
function labelHtml(item, currency, shopName, opts) {
  const value = barcodeValue(item)
  const price = rateText(item, currency, opts.rate)
  const showCode = opts.code && value
  const showMeta = showCode || price
  return `
    <div class="label">
      ${opts.company && shopName ? `<div class="shop">${escapeHtml(shopName)}</div>` : ''}
      ${opts.itemName ? `<div class="nm">${escapeHtml(item.name || '')}</div>` : ''}
      ${opts.barcode ? `<div class="bc">${barcodeSvg(value)}</div>` : ''}
      ${showMeta ? `<div class="meta">
        <span class="code">${showCode ? escapeHtml(value) : ''}</span>
        <span class="price">${escapeHtml(price)}</span>
      </div>` : ''}
    </div>`
}

// Default label contents — item name off per shop preference, retail rate shown.
export const DEFAULT_LABEL_OPTS = {
  company: true,
  itemName: false,
  barcode: true,
  code: true,
  rate: 'customer', // 'none' | 'customer' | 'dealer'
}

// Chunk a flat list of label cells into rows of COLS. Each row prints as its own
// page (see the @page rule) so one physical label pitch = one printed page — the
// TSC gap sensor then advances the ~2.7mm die gap itself. That's why there is no
// CSS row-gap: adding it here would double-count the gap and drift every row
// down the roll.
function rowsHtml(cells) {
  const rows = []
  for (let i = 0; i < cells.length; i += COLS) {
    rows.push(`<div class="row">${cells.slice(i, i + COLS).join('')}</div>`)
  }
  return rows.join('')
}

// Build the full printable HTML document for a set of items. Shared by
// printBarcodeLabels (hidden iframe) and previewBarcodeLabels (visible tab) so
// what you preview is byte-for-byte what prints.
function buildLabelsHtml(printable, currency, shopName, opts) {
  const cells = printable.map((it) => labelHtml(it, currency, shopName, opts))
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Barcode labels</title>
    <style>
      /* Pin the page to exactly one label row: full media width × one label
         height, zero margin. Height is fixed (not "auto") so the printer can't
         pad each row out to a default form length — that padding was the blank
         band under every label. The gap sensor feeds the die gap between rows. */
      @page { size: ${SHEET_W} ${LABEL_H}; margin: 0; }
      * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      html, body { margin: 0; padding: 0; }
      body { font-family: Arial, Helvetica, sans-serif; color: #000; }
      /* One .row = one page = 3 labels across. column-gap = horizontal die gap. */
      .row {
        display: flex;
        width: ${SHEET_W};
        height: ${LABEL_H};
        column-gap: ${COL_GAP};
        break-inside: avoid; page-break-inside: avoid;
      }
      .row:not(:last-child) { break-after: page; page-break-after: always; }
      .label {
        width: ${LABEL_W}; height: ${LABEL_H}; padding: 1.5mm;
        display: flex; flex-direction: column; align-items: center; justify-content: space-between;
        overflow: hidden; page-break-inside: avoid; break-inside: avoid;
      }
      .shop {
        width: 100%; text-align: center; font-size: 6pt; font-weight: 700; line-height: 1.05;
        text-transform: uppercase; letter-spacing: 0.2px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .nm {
        width: 100%; text-align: center; font-size: 6pt; font-weight: 600; line-height: 1.05;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .bc { width: 100%; flex: 1 1 auto; display: flex; align-items: center; justify-content: center; min-height: 0; }
      .bc svg { width: 100%; height: 100%; }
      .meta { width: 100%; display: flex; align-items: baseline; justify-content: space-between; gap: 1mm; }
      .code { font-size: 6pt; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .price { font-size: 7pt; font-weight: 700; white-space: nowrap; }
    </style>
  </head>
  <body>${rowsHtml(cells)}</body>
</html>`
}

// Shared front end for both entry points: filter to printable items, warn if
// none, else build the HTML and hand it to `sink`.
function withLabelsHtml(items, { currency = '₹', shopName = '', labelOpts } = {}, sink) {
  const opts = { ...DEFAULT_LABEL_OPTS, ...labelOpts }
  const printable = items.filter((it) => barcodeValue(it))
  if (!printable.length) {
    window.alert('This item has no barcode or Item No yet, so there is nothing to print. Add a barcode in Edit first.')
    return
  }
  sink(buildLabelsHtml(printable, currency, shopName, opts))
}

// Print an array of items as labels (pass the same item N times for N copies).
// shopName is printed across the top of every label as store branding.
// `labelOpts` selects what each label shows (see DEFAULT_LABEL_OPTS).
export function printBarcodeLabels(items, opts = {}) {
  withLabelsHtml(items, opts, (html) => {
    const iframe = document.createElement('iframe')
    iframe.setAttribute('aria-hidden', 'true')
    Object.assign(iframe.style, {
      position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0',
    })
    document.body.appendChild(iframe)

    const doc = iframe.contentWindow.document
    doc.open()
    doc.write(html)
    doc.close()

    // Give the iframe a tick to lay out the SVGs before printing, then clean up.
    const cleanup = () => setTimeout(() => iframe.remove(), 1000)
    setTimeout(() => {
      iframe.contentWindow.focus()
      iframe.contentWindow.print()
      cleanup()
    }, 150)
  })
}

// Open the exact same label sheet in a visible tab (no auto-print) so you can
// eyeball the layout — and Ctrl+P → Save as PDF to check sizing — before
// sending a roll through the printer.
export function previewBarcodeLabels(items, opts = {}) {
  withLabelsHtml(items, opts, (html) => {
    const win = window.open('', '_blank')
    if (!win) {
      window.alert('Your browser blocked the preview window. Allow pop-ups for this site and try again.')
      return
    }
    win.document.open()
    win.document.write(html)
    win.document.close()
  })
}
