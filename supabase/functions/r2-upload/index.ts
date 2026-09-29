// r2-upload — hands the browser short-lived upload links for Cloudflare R2.
//
// Why this exists: photos moved off Supabase Storage (the free plan's 5 GB
// cached-egress cap got the old project restricted in September 2026). R2 has
// 10 GB free and no egress fees. The R2 secret key must never reach the
// browser, so this function checks who is asking and signs one PUT link per
// file; the browser then uploads straight to R2.
//
// Same rules as the old storage policies (migrations 012/013): owner or staff
// only, and only into their own shop's folder.
//
// Request:  POST { bucket: 'item-photos'|'brand-assets', folder: '<shopId>[/banners]',
//                  files: ['jpg', 't.jpg'] }        // or ['png']
// Response: { uploads: [{ url, publicUrl }] }       // same order as files
// The browser PUTs each file to `url` within 5 minutes.
//
// Secrets:  supabase secrets set R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... \
//             R2_SECRET_ACCESS_KEY=... R2_BUCKET=... R2_PUBLIC_URL=https://...
// Deploy:   supabase functions deploy r2-upload --use-api

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { AwsClient } from 'https://esm.sh/aws4fetch@1.0.20'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

const BUCKETS = new Set(['item-photos', 'brand-assets'])
const SUFFIXES = new Set(['jpg', 't.jpg', 'png'])

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const accountId = Deno.env.get('R2_ACCOUNT_ID')
  const accessKeyId = Deno.env.get('R2_ACCESS_KEY_ID')
  const secretAccessKey = Deno.env.get('R2_SECRET_ACCESS_KEY')
  const r2Bucket = Deno.env.get('R2_BUCKET')
  const publicBase = (Deno.env.get('R2_PUBLIC_URL') ?? '').replace(/\/+$/, '')
  if (!accountId || !accessKeyId || !secretAccessKey || !r2Bucket || !publicBase) {
    return json({ error: 'Photo storage is not set up yet. Ask the developer to add the R2 secrets.' }, 500)
  }

  // --- 1. Who is asking? Read their profile under their own RLS. ---
  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader) return json({ error: 'Not signed in.' }, 401)
  const asCaller = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: userData, error: userErr } = await asCaller.auth.getUser()
  if (userErr || !userData?.user) return json({ error: 'Not signed in.' }, 401)
  const { data: caller, error: callerErr } = await asCaller
    .from('profiles')
    .select('role, shop_id')
    .eq('id', userData.user.id)
    .maybeSingle()
  if (callerErr) return json({ error: callerErr.message }, 400)
  if (caller?.role !== 'owner' && caller?.role !== 'staff') {
    return json({ error: 'Only the shop can upload photos.' }, 403)
  }
  if (!caller.shop_id) return json({ error: 'Your account is not linked to a shop.' }, 400)

  // --- 2. Validate the request. ---
  let body: { bucket?: string; folder?: string; files?: string[] }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid request body.' }, 400)
  }
  const bucket = body.bucket ?? ''
  const folder = (body.folder ?? '').replace(/^\/+|\/+$/g, '')
  const files = Array.isArray(body.files) ? body.files : []
  if (!BUCKETS.has(bucket)) return json({ error: 'Unknown photo folder.' }, 400)
  if (!/^[0-9a-f-]{36}(\/banners)?$/.test(folder) || folder.split('/')[0] !== caller.shop_id) {
    return json({ error: "You can only upload to your own shop's photos." }, 403)
  }
  if (!files.length || files.length > 2 || !files.every((f) => SUFFIXES.has(f))) {
    return json({ error: 'Invalid file list.' }, 400)
  }

  // --- 3. Sign one PUT link per file. All files share one new id, so the
  //        thumbnail sits beside its photo as <id>.t.jpg. ---
  const r2 = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' })
  const endpoint = `https://${accountId}.r2.cloudflarestorage.com/${r2Bucket}`
  const id = crypto.randomUUID()
  const uploads = await Promise.all(files.map(async (suffix) => {
    const key = `${bucket}/${folder}/${id}.${suffix}`
    const signed = await r2.sign(
      new Request(`${endpoint}/${key}?X-Amz-Expires=300`, { method: 'PUT' }),
      { aws: { signQuery: true } },
    )
    return { url: signed.url, publicUrl: `${publicBase}/${key}` }
  }))

  return json({ uploads })
})
