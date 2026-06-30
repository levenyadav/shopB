// Tiny CSV reader/writer for Bulk Purchase Entry (SPEC §15). Hand-written to
// avoid a dependency — handles quoted fields, embedded commas/newlines, escaped
// double-quotes ("") and both \n and \r\n line endings. Good enough for the
// purchase template; not a full RFC-4180 parser.

// Parse CSV text into { headers: string[], rows: object[] }. The first
// non-empty line is the header; each row maps header -> cell (trimmed).
export function parseCsv(text) {
  const records = tokenize(text)
  if (!records.length) return { headers: [], rows: [] }
  const headers = records[0].map((h) => h.trim())
  const rows = []
  for (let i = 1; i < records.length; i++) {
    const cells = records[i]
    // Skip blank lines (a single empty cell).
    if (cells.length === 1 && cells[0].trim() === '') continue
    const row = {}
    headers.forEach((h, c) => { row[h] = (cells[c] ?? '').trim() })
    rows.push(row)
  }
  return { headers, rows }
}

// Split raw text into an array of records, each an array of field strings.
function tokenize(text) {
  const records = []
  let field = ''
  let record = []
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } // escaped quote
        else inQuotes = false
      } else field += ch
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      record.push(field); field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++ // consume \r\n as one break
      record.push(field); records.push(record); field = ''; record = []
    } else {
      field += ch
    }
  }
  // Flush trailing field/record if the file doesn't end with a newline.
  if (field !== '' || record.length) { record.push(field); records.push(record) }
  return records
}

// Build a CSV string from headers + array-of-objects. Quotes any cell that
// contains a comma, quote or newline.
export function toCsv(headers, rows) {
  const esc = (v) => {
    const s = v == null ? '' : String(v)
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [headers.map(esc).join(',')]
  for (const row of rows) lines.push(headers.map((h) => esc(row[h])).join(','))
  return lines.join('\n')
}

// Trigger a browser download of arbitrary text as a file.
export function downloadText(filename, text, type = 'text/csv') {
  const blob = new Blob([text], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
