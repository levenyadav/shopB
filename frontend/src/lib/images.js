import { supabase } from './supabase'

// Photos live in Cloudflare R2, not Supabase Storage. Supabase's free plan
// allows 5 GB of photo traffic a month; raw phone photos blew through it in
// September 2026 and the whole project was restricted. R2 gives 10 GB free and
// charges nothing for traffic. Every upload is still shrunk in the browser and a
// small thumbnail stored beside it, so screens load fast on shop Wi-Fi.
//
// Upload flow: the r2-upload Edge Function checks the caller (owner/staff, own
// shop) and returns short-lived signed PUT links; the browser uploads straight
// to R2. The R2 secret key never reaches the browser.
//
// Key layout (one R2 bucket, old Supabase bucket names kept as the first folder):
//   <bucket>/<shopId>/<uuid>.jpg      full photo, longest side ≤ 1200px (~100–200 KB)
//   <bucket>/<shopId>/<uuid>.t.jpg    thumbnail, longest side ≤ 320px (~15–30 KB)
// Keys are unique per upload and never overwritten, so browsers may keep them
// for a year.

const FULL_MAX = 1200
const THUMB_MAX = 320
const CACHE_ONE_YEAR = '31536000'

// Resize an image File/Blob to fit within `max` px and re-encode (JPEG by
// default, or PNG to keep transparency). Never upscales. Falls back to the
// original file if the browser can't decode it.
export async function shrinkImage(file, max = FULL_MAX, quality = 0.8, type = 'image/jpeg') {
  let bitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    return file
  }
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height))
  const w = Math.round(bitmap.width * scale)
  const h = Math.round(bitmap.height * scale)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (type === 'image/jpeg') {
    // JPEG has no transparency — paint white so transparent areas don't turn black.
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, w, h)
  }
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close?.()
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, quality))
  // Keep the original only if re-encoding somehow made it bigger and it's already small.
  if (!blob || (blob.size > file.size && scale === 1)) return file
  return blob
}

// Shrink + upload a photo and its thumbnail. Returns the full photo's public URL.
// `keepTransparency` stores a single PNG (brand logos/icons) at up to `max` px.
// `folder` is the shop id, optionally followed by a subfolder (`<shopId>/banners`).
export async function uploadPhoto(bucket, folder, file, { keepTransparency = false, max = FULL_MAX } = {}) {
  if (!file) return null

  if (keepTransparency) {
    const png = await shrinkImage(file, max, undefined, 'image/png')
    const [link] = await signUploads(bucket, folder, ['png'])
    await putFile(link.url, png, 'image/png')
    return link.publicUrl
  }

  const [full, thumb] = await Promise.all([
    shrinkImage(file, max, 0.8),
    shrinkImage(file, THUMB_MAX, 0.75),
  ])
  const [fullLink, thumbLink] = await signUploads(bucket, folder, ['jpg', 't.jpg'])
  // contentType follows the blob: shrinkImage hands back the original file if the
  // browser couldn't decode it (e.g. HEIC on some desktops).
  await putFile(fullLink.url, full, full.type || 'image/jpeg')
  // A missing thumbnail only costs bandwidth (thumbUrl falls back), so don't fail the save.
  await putFile(thumbLink.url, thumb, thumb.type || 'image/jpeg').catch(() => {})
  return fullLink.publicUrl
}

async function signUploads(bucket, folder, files) {
  const { data, error } = await supabase.functions.invoke('r2-upload', {
    body: { bucket, folder, files },
  })
  if (error) {
    // functions.invoke hides the function's own message inside error.context.
    let msg = error.message
    try { msg = (await error.context.json()).error || msg } catch { /* keep generic */ }
    throw new Error('Photo upload failed: ' + msg)
  }
  return data.uploads
}

async function putFile(url, blob, contentType) {
  let res
  try {
    res = await fetch(url, {
      method: 'PUT',
      body: blob,
      headers: { 'Content-Type': contentType, 'Cache-Control': `public, max-age=${CACHE_ONE_YEAR}, immutable` },
    })
  } catch {
    throw new Error('Photo upload failed: no internet connection. Check the connection and save again.')
  }
  if (!res.ok) throw new Error(`Photo upload failed (error ${res.status}). Try saving again.`)
}

// The thumbnail URL for a photo stored by uploadPhoto (or the migration script),
// in R2 or in old Supabase Storage. Anything else — pasted links, the thumbnail
// itself — is returned unchanged. Render with onError falling back to the full
// URL (see <Img>).
export function thumbUrl(url) {
  if (!url || !/\/(item-photos|brand-assets)\//.test(url)) return url
  if (/\.t\.jpg$/i.test(url)) return url
  return url.replace(/\.(jpe?g|png|webp|heic|heif|gif)$/i, '.t.jpg')
}
