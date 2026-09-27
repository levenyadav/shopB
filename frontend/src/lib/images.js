import { supabase } from './supabase'

// Photos are the only thing that eats the Supabase "cached egress" quota: the
// free plan allows 5 GB a month and has no server-side image resizing. Raw phone
// photos (2–9 MB each) shown as 56px tiles blew through it in September 2026 and
// the whole project was restricted. So every upload is shrunk in the browser and
// a small thumbnail is stored beside it; list screens show only the thumbnail.
//
// Storage layout (item-photos and brand-assets buckets):
//   <shopId>/<uuid>.jpg      full photo, longest side ≤ 1200px (~100–200 KB)
//   <shopId>/<uuid>.t.jpg    thumbnail, longest side ≤ 320px (~15–30 KB)
// Paths are unique per upload and never overwritten, so browsers may keep them
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
export async function uploadPhoto(bucket, shopId, file, { keepTransparency = false, max = FULL_MAX } = {}) {
  if (!file) return null
  const id = crypto.randomUUID()
  const store = supabase.storage.from(bucket)

  if (keepTransparency) {
    const png = await shrinkImage(file, max, undefined, 'image/png')
    const path = `${shopId}/${id}.png`
    const { error } = await store.upload(path, png, {
      upsert: false, contentType: png.type || 'image/png', cacheControl: CACHE_ONE_YEAR,
    })
    if (error) throw new Error('Photo upload failed: ' + error.message)
    return store.getPublicUrl(path).data.publicUrl
  }

  const [full, thumb] = await Promise.all([
    shrinkImage(file, max, 0.8),
    shrinkImage(file, THUMB_MAX, 0.75),
  ])
  const path = `${shopId}/${id}.jpg`
  // contentType follows the blob: shrinkImage hands back the original file if the
  // browser couldn't decode it (e.g. HEIC on some desktops).
  const opts = (b) => ({ upsert: false, contentType: b.type || 'image/jpeg', cacheControl: CACHE_ONE_YEAR })
  const { error } = await store.upload(path, full, opts(full))
  if (error) throw new Error('Photo upload failed: ' + error.message)
  // A missing thumbnail only costs bandwidth (thumbUrl falls back), so don't fail the save.
  await store.upload(`${shopId}/${id}.t.jpg`, thumb, opts(thumb))
  return store.getPublicUrl(path).data.publicUrl
}

// The thumbnail URL for a photo stored by uploadPhoto (or the backfill script).
// Anything else — pasted links, the thumbnail itself — is returned unchanged.
// Render with onError falling back to the full URL (see <Img>).
export function thumbUrl(url) {
  if (!url || !/\/storage\/v1\/object\/public\/(item-photos|brand-assets)\//.test(url)) return url
  if (/\.t\.jpg$/i.test(url)) return url
  return url.replace(/\.(jpe?g|png|webp|heic|heif|gif)$/i, '.t.jpg')
}
