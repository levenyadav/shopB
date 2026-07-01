import { Link } from 'react-router-dom'
import { IconMoodEmpty } from '@tabler/icons-react'
import { useShop } from '../../context/ShopContext'
import { Spinner } from '../../components/ui'

// SPEC §10 — public footer pages (About / Privacy / Terms / Contact). Content is
// owner-editable from Settings and stored as a text column on `shops`, read here
// via the public shops_select policy. A blank column = page not published.
//
// Rendering is deliberately a *tiny* Markdown subset (no HTML injection): blank
// lines split paragraphs, lines starting with "- " become bullet lists, and
// **bold** spans render as <strong>. Plain text just works.
export default function ContentPage({ column, title }) {
  const { shop } = useShop()

  if (shop === undefined || shop === null) {
    return <div className="grid place-items-center py-20 text-muted"><Spinner /></div>
  }

  const body = (shop[column] || '').trim()

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-6 font-[var(--font-display)] text-3xl font-bold text-ink">{title}</h1>
      {body ? (
        <article className="space-y-4 text-ink/90">{renderMarkdown(body)}</article>
      ) : (
        <div className="grid place-items-center gap-3 rounded-lg border border-dashed border-line py-20 text-center text-muted">
          <IconMoodEmpty size={40} stroke={1.3} />
          <p>This page hasn't been written yet.</p>
          <Link to="/" className="font-medium text-peacock hover:underline">Back to the shop</Link>
        </div>
      )}
    </div>
  )
}

// --- minimal, injection-safe Markdown subset -------------------------------
function inline(text, keyBase) {
  // Split on **bold** and render the bold runs as <strong>; everything else
  // stays plain text (no raw HTML ever reaches the DOM).
  return text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((part, i) =>
    part.startsWith('**') && part.endsWith('**')
      ? <strong key={`${keyBase}-${i}`}>{part.slice(2, -2)}</strong>
      : <span key={`${keyBase}-${i}`}>{part}</span>,
  )
}

function renderMarkdown(body) {
  // Blocks are separated by blank lines. A block whose lines all start with
  // "- " becomes a <ul>; otherwise it's a paragraph (single newlines -> <br/>).
  return body.split(/\n\s*\n/).map((block, b) => {
    const lines = block.split('\n')
    const isList = lines.every((l) => /^\s*-\s+/.test(l))
    if (isList) {
      return (
        <ul key={b} className="list-disc space-y-1 pl-5">
          {lines.map((l, i) => (
            <li key={i}>{inline(l.replace(/^\s*-\s+/, ''), `${b}-${i}`)}</li>
          ))}
        </ul>
      )
    }
    return (
      <p key={b} className="leading-relaxed">
        {lines.map((l, i) => (
          <span key={i}>
            {inline(l, `${b}-${i}`)}
            {i < lines.length - 1 && <br />}
          </span>
        ))}
      </p>
    )
  })
}
