import { useState } from 'react'

// Shared shop brand mark. Precedence (set in Settings → Branding):
//   1. logo_url    — image logo
//   2. brand_text  — text wordmark
//   3. name        — the legal shop name (always present)
// The text fallbacks render as the existing "shop-stamp" so headers keep their
// look when no image logo is set. `maxWords` trims long names in tight spots.
export default function Brand({ shop, maxWords = 3, textClassName = '', logoClassName = 'h-8' }) {
  const [imgOk, setImgOk] = useState(true)
  const text = shop?.brand_text?.trim() ||
    (shop?.name?.split(' ').slice(0, maxWords).join(' ') || 'Shop')

  if (shop?.logo_url && imgOk) {
    return (
      <img
        src={shop.logo_url}
        alt={shop?.name || 'Shop'}
        className={`w-auto object-contain ${logoClassName}`}
        onError={() => setImgOk(false)}
      />
    )
  }
  return <span className={`shop-stamp font-bold ${textClassName}`}>{text}</span>
}
