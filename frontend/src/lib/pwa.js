// PWA glue: dynamic Web App Manifest, brand/theme colour and service-worker
// registration. The shop's identity (name, icon, brand colour) lives in the
// single shops row and is edited in Settings → Branding, so the installable app
// must mirror those DB values rather than a static build-time manifest. We build
// the manifest at runtime from the shop record and inject it as a blob URL.

const DEFAULT_THEME = '#0F6E64' // --color-peacock
const BACKGROUND = '#EFECE1' // --color-paper

const isHexColor = (v) => /^#[0-9a-f]{6}$/i.test(v || '')

// Darken a #rrggbb hex by `amount` (0..1) — used for the pressed primary shade
// so a custom brand colour still gets a matching --color-peacock-700.
export function darken(hex, amount = 0.22) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '')
  if (!m) return hex
  const n = parseInt(m[1], 16)
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) =>
    Math.max(0, Math.round(v * (1 - amount)))
  )
  return '#' + ch.map((v) => v.toString(16).padStart(2, '0')).join('')
}

function mimeFromUrl(url) {
  const u = (url || '').split('?')[0].toLowerCase()
  if (u.endsWith('.png')) return 'image/png'
  if (u.endsWith('.jpg') || u.endsWith('.jpeg')) return 'image/jpeg'
  if (u.endsWith('.svg')) return 'image/svg+xml'
  if (u.endsWith('.webp')) return 'image/webp'
  return undefined
}

// Build a Web App Manifest object from the shop record.
export function buildManifest(shop) {
  const name = (shop?.name || 'Shop').trim()
  const short =
    (shop?.brand_text || shop?.name || 'Shop').trim().split(/\s+/).slice(0, 2).join(' ') || name
  const theme = isHexColor(shop?.theme_color) ? shop.theme_color : DEFAULT_THEME

  // Chrome needs a 192px and a 512px icon to offer install. The uploaded icon is
  // a single arbitrary-size image, so we declare it at both sizes (widely
  // tolerated) with a plain SVG fallback when no icon is set.
  const type = mimeFromUrl(shop?.icon_url)
  const icons = shop?.icon_url
    ? [
        { src: shop.icon_url, sizes: '192x192', ...(type ? { type } : {}), purpose: 'any' },
        { src: shop.icon_url, sizes: '512x512', ...(type ? { type } : {}), purpose: 'any' },
      ]
    : [{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }]

  return {
    name,
    short_name: short,
    description: name,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: BACKGROUND,
    theme_color: theme,
    icons,
  }
}

let manifestBlobUrl = null
function syncManifest(shop) {
  const blob = new Blob([JSON.stringify(buildManifest(shop))], {
    type: 'application/manifest+json',
  })
  const url = URL.createObjectURL(blob)
  let link = document.querySelector('link[rel="manifest"]')
  if (!link) {
    link = document.createElement('link')
    link.rel = 'manifest'
    document.head.appendChild(link)
  }
  link.href = url
  if (manifestBlobUrl) URL.revokeObjectURL(manifestBlobUrl)
  manifestBlobUrl = url
}

function setMeta(name, content) {
  let m = document.querySelector(`meta[name="${name}"]`)
  if (!m) {
    m = document.createElement('meta')
    m.name = name
    document.head.appendChild(m)
  }
  m.content = content
}

function setLink(rel, href) {
  let l = document.querySelector(`link[rel="${rel}"]`)
  if (!l) {
    l = document.createElement('link')
    l.rel = rel
    document.head.appendChild(l)
  }
  l.href = href
}

// Push the shop's brand colour into the live CSS variables so the whole primary
// theme (buttons, active nav, focus ring) follows it, plus the browser bar.
export function applyThemeColor(shop) {
  const theme = isHexColor(shop?.theme_color) ? shop.theme_color : DEFAULT_THEME
  const root = document.documentElement
  root.style.setProperty('--color-peacock', theme)
  root.style.setProperty('--color-peacock-700', darken(theme))
  setMeta('theme-color', theme)
}

// One call to reflect the whole shop identity into the document + manifest.
// Safe to call repeatedly (e.g. after Settings saves refresh the shop).
export function applyBranding(shop) {
  if (!shop) return
  if (shop.name) {
    document.title = shop.name
    setMeta('apple-mobile-web-app-title', shop.brand_text || shop.name)
  }
  if (shop.icon_url) {
    setLink('icon', shop.icon_url)
    setLink('apple-touch-icon', shop.icon_url)
  }
  applyThemeColor(shop)
  try {
    syncManifest(shop)
  } catch {
    /* manifest is progressive enhancement — never block the app on it */
  }
}

// Register the service worker (required, together with the manifest + HTTPS, for
// the browser to offer "Install app"). No-op where unsupported.
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}
